import { and, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { ESTIMATED_ARRIVAL_SOURCES } from '../../shared/types';
import type { Db } from '../db/client';
import { shipments, trackingEvents, trackingRuns } from '../db/schema';
import { applyTrackingResult, latestEventAt, lineChanged } from './apply';
import { TrackingRateLimitError, type TrackingProvider, type TrackingRequest, type TrackingResult } from './provider';

/**
 * Distinct tracking numbers per refresh call. Workers' free plan allows 50 outbound requests per
 * invocation and database queries count too: 20 lookups + 4 queries leaves headroom.
 */
export const REFRESH_BATCH_SIZE = 20;
/** Don't re-check a number more often than this unless forced. */
const MIN_HOURS_BETWEEN_CHECKS = 6;

/** `line`: specific shipments (with `shipmentIds`), whatever their arrival state. */
export type RefreshScope = 'open' | 'estimated' | 'line';

export interface RefreshOptions {
  /** `open`: lines not arrived yet. `estimated`: arrived lines whose date is only a report estimate. */
  scope: RefreshScope;
  branch?: string | null;
  shipmentIds?: number[];
  force?: boolean;
  /** Run to add this batch's totals to and to stamp changed lines with. */
  runId?: number;
}

export interface RefreshResult {
  /** Distinct tracking numbers looked up in this call. */
  checked: number;
  found: number;
  linesUpdated: number;
  arrivalsConfirmed: number;
  /** Numbers still due for a check after this call (call again to continue). */
  remaining: number;
  rateLimited: boolean;
  retryAfterSeconds: number | null;
  ignoredDeliveries: number;
  /** Numbers the provider had no data for. */
  notFound: number;
  /** Lines whose status, dates or scans actually changed. */
  linesChanged: number;
}

function candidateFilter(opts: RefreshOptions, carriers: string[]): SQL {
  const notRecent = opts.force
    ? undefined
    : or(
        isNull(shipments.lastTrackedAt),
        lt(shipments.lastTrackedAt, sql`now() - make_interval(hours => ${MIN_HOURS_BETWEEN_CHECKS})`),
      );
  const scope =
    opts.scope === 'open'
      ? isNull(shipments.actualArrivalDate)
      : opts.scope === 'estimated'
        ? inArray(shipments.arrivalSource, [...ESTIMATED_ARRIVAL_SOURCES])
        : undefined;
  return and(
    isNotNull(shipments.trackingNumber),
    // Only carriers a connected provider handles; others would fill the batch and never be checked.
    inArray(shipments.carrier, carriers),
    scope,
    notRecent,
    opts.branch ? eq(shipments.branch, opts.branch) : undefined,
    opts.shipmentIds?.length ? inArray(shipments.id, opts.shipmentIds) : undefined,
  )!;
}

/**
 * Looks up one batch of tracking numbers and writes status, ETA, events and confirmed arrivals to
 * every line sharing each number. Shared by the API route and (later) a cron Worker.
 */
export async function refreshTracking(db: Db, providers: TrackingProvider[], opts: RefreshOptions): Promise<RefreshResult> {
  const carriers = [...new Set(providers.flatMap((p) => p.carriers))];
  const where = candidateFilter(opts, carriers.length ? carriers : ['']);
  const numbers = await db
    .select({
      trackingNumber: shipments.trackingNumber,
      carrier: sql<string | null>`min(${shipments.carrier})`,
      mode: sql<TrackingRequest['mode']>`min(${shipments.mode}::text)`,
      shipDate: sql<string | null>`min(${shipments.shipDate})`,
    })
    .from(shipments)
    .where(where)
    .groupBy(shipments.trackingNumber)
    .orderBy(sql`min(${shipments.lastTrackedAt}) asc nulls first`, shipments.trackingNumber)
    .limit(REFRESH_BATCH_SIZE);

  const [{ total }] = await db
    .select({ total: sql<number>`count(distinct ${shipments.trackingNumber})::int` })
    .from(shipments)
    .where(where);

  const result: RefreshResult = {
    checked: 0,
    found: 0,
    linesUpdated: 0,
    arrivalsConfirmed: 0,
    remaining: Math.max(0, total - numbers.length),
    rateLimited: false,
    retryAfterSeconds: null,
    ignoredDeliveries: 0,
    notFound: 0,
    linesChanged: 0,
  };
  const runUpdate = () =>
    db
      .update(trackingRuns)
      .set({
        batches: sql`${trackingRuns.batches} + 1`,
        checked: sql`${trackingRuns.checked} + ${result.checked}`,
        found: sql`${trackingRuns.found} + ${result.found}`,
        notFound: sql`${trackingRuns.notFound} + ${result.notFound}`,
        linesUpdated: sql`${trackingRuns.linesUpdated} + ${result.linesUpdated}`,
        linesChanged: sql`${trackingRuns.linesChanged} + ${result.linesChanged}`,
        arrivalsConfirmed: sql`${trackingRuns.arrivalsConfirmed} + ${result.arrivalsConfirmed}`,
        ignoredDeliveries: sql`${trackingRuns.ignoredDeliveries} + ${result.ignoredDeliveries}`,
        remaining: result.remaining,
        rateLimited: result.rateLimited,
        updatedAt: new Date(),
      })
      .where(eq(trackingRuns.id, opts.runId!));
  if (!numbers.length) {
    if (opts.runId) await runUpdate();
    return result;
  }

  const requests = numbers as TrackingRequest[];
  const results = new Map<string, { provider: string; result: TrackingResult }>();
  const attempted = new Set<string>();
  /** Provider that looked up each number, so not-found lines record who said so. */
  const askedProvider = new Map<string, string>();
  for (const provider of providers) {
    const mine = requests.filter((r) => !attempted.has(r.trackingNumber) && provider.supports(r));
    if (!mine.length) continue;
    let found: TrackingResult[];
    try {
      found = await provider.track(mine);
      mine.forEach((r) => attempted.add(r.trackingNumber));
      mine.forEach((r) => askedProvider.set(r.trackingNumber, provider.name));
    } catch (err) {
      if (!(err instanceof TrackingRateLimitError)) throw err;
      result.rateLimited = true;
      result.retryAfterSeconds = err.retryAfterSeconds;
      found = err.partial;
      found.forEach((r) => attempted.add(r.trackingNumber));
      found.forEach((r) => askedProvider.set(r.trackingNumber, provider.name));
    }
    for (const r of found) results.set(r.trackingNumber, { provider: provider.name, result: r });
    if (result.rateLimited) break;
  }
  result.checked = attempted.size;
  result.found = results.size;
  result.notFound = attempted.size - results.size;
  result.remaining = Math.max(0, total - attempted.size);
  if (!attempted.size) {
    if (opts.runId) await runUpdate();
    return result;
  }

  // Every line that uses one of the attempted numbers (within the same scope/branch).
  const lines = await db
    .select({
      id: shipments.id,
      trackingNumber: shipments.trackingNumber,
      status: shipments.status,
      shipDate: shipments.shipDate,
      estimatedArrivalDate: shipments.estimatedArrivalDate,
      actualArrivalDate: shipments.actualArrivalDate,
      arrivalSource: shipments.arrivalSource,
      lastEventAt: shipments.lastEventAt,
    })
    .from(shipments)
    .where(and(where, inArray(shipments.trackingNumber, [...attempted])));

  const now = new Date();
  const writes = [];
  const notFoundIds = new Map<string, number[]>();
  for (const line of lines) {
    const hit = results.get(line.trackingNumber!);
    if (!hit) {
      const provider = askedProvider.get(line.trackingNumber!) ?? providers[0].name;
      notFoundIds.set(provider, [...(notFoundIds.get(provider) ?? []), line.id]);
      continue;
    }
    const update = applyTrackingResult(line, hit.result);
    const newestEvent = latestEventAt(hit.result);
    const changed = lineChanged(line, update, newestEvent);
    if (changed) result.linesChanged++;
    if (update.ignoredDelivery) {
      result.ignoredDeliveries++;
      console.warn(`Line ${line.id}: ${update.ignoredDelivery}`);
    }
    if (update.confirmedArrival) result.arrivalsConfirmed++;
    result.linesUpdated++;
    writes.push(
      db
        .update(shipments)
        .set({
          status: update.status,
          estimatedArrivalDate: update.estimatedArrivalDate,
          actualArrivalDate: update.actualArrivalDate,
          arrivalSource: update.arrivalSource,
          ...(update.confirmedArrival ? { arrivalWindowStart: null, arrivalWindowEnd: null } : {}),
          lastTrackedAt: now,
          trackingProvider: hit.provider,
          trackingFound: true,
          trackedCarrier: hit.result.carrier ?? sql`${shipments.trackedCarrier}`,
          lastEventAt: newestEvent ? new Date(newestEvent) : sql`${shipments.lastEventAt}`,
          ...(changed ? { trackingChangedAt: now, trackingRunId: opts.runId ?? null, updatedAt: now } : {}),
        })
        .where(eq(shipments.id, line.id)),
      db.delete(trackingEvents).where(and(eq(trackingEvents.shipmentId, line.id), eq(trackingEvents.provider, hit.provider))),
    );
    if (hit.result.events.length) {
      writes.push(
        db.insert(trackingEvents).values(
          hit.result.events.map((e) => ({
            shipmentId: line.id,
            occurredAt: new Date(e.occurredAt),
            status: e.status,
            description: e.description ?? null,
            location: e.location ?? null,
            provider: hit.provider,
            raw: e.raw ?? null,
          })),
        ),
      );
    }
  }
  // Numbers the provider had nothing on still count as checked, so they wait before the next try.
  // A line found earlier keeps trackingFound = true (a provider can briefly return nothing).
  for (const [provider, ids] of notFoundIds) {
    writes.push(
      db
        .update(shipments)
        .set({
          lastTrackedAt: now,
          trackingProvider: provider,
          trackingFound: sql`coalesce(${shipments.trackingFound}, false)`,
        })
        .where(inArray(shipments.id, ids)),
    );
  }
  if (opts.runId) writes.push(runUpdate());

  // One round trip, one transaction.
  if (writes.length) await db.batch(writes as [(typeof writes)[number], ...typeof writes]);
  return result;
}
