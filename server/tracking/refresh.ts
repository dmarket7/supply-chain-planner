import { and, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { ESTIMATED_ARRIVAL_SOURCES } from '../../shared/types';
import type { Db } from '../db/client';
import { shipments, trackingEvents } from '../db/schema';
import { applyTrackingResult } from './apply';
import { TrackingRateLimitError, type TrackingProvider, type TrackingRequest, type TrackingResult } from './provider';

/**
 * Distinct tracking numbers per refresh call. Workers' free plan allows 50 outbound requests per
 * invocation and database queries count too: 20 lookups + 4 queries leaves headroom.
 */
export const REFRESH_BATCH_SIZE = 20;
/** Don't re-check a number more often than this unless forced. */
const MIN_HOURS_BETWEEN_CHECKS = 6;

export type RefreshScope = 'open' | 'estimated';

export interface RefreshOptions {
  /** `open`: lines not arrived yet. `estimated`: arrived lines whose date is only a report estimate. */
  scope: RefreshScope;
  branch?: string | null;
  shipmentIds?: number[];
  force?: boolean;
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
}

function candidateFilter(opts: RefreshOptions): SQL {
  const notRecent = opts.force
    ? undefined
    : or(
        isNull(shipments.lastTrackedAt),
        lt(shipments.lastTrackedAt, sql`now() - make_interval(hours => ${MIN_HOURS_BETWEEN_CHECKS})`),
      );
  const scope =
    opts.scope === 'open'
      ? isNull(shipments.actualArrivalDate)
      : inArray(shipments.arrivalSource, [...ESTIMATED_ARRIVAL_SOURCES]);
  return and(
    isNotNull(shipments.trackingNumber),
    // Only formats we recognized; unrecognized references would just burn tracker quota.
    isNotNull(shipments.carrier),
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
  const where = candidateFilter(opts);
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
  };
  if (!numbers.length) return result;

  const requests = numbers as TrackingRequest[];
  const results = new Map<string, { provider: string; result: TrackingResult }>();
  const attempted = new Set<string>();
  for (const provider of providers) {
    const mine = requests.filter((r) => !attempted.has(r.trackingNumber) && provider.supports(r));
    if (!mine.length) continue;
    let found: TrackingResult[];
    try {
      found = await provider.track(mine);
      mine.forEach((r) => attempted.add(r.trackingNumber));
    } catch (err) {
      if (!(err instanceof TrackingRateLimitError)) throw err;
      result.rateLimited = true;
      result.retryAfterSeconds = err.retryAfterSeconds;
      found = err.partial;
      found.forEach((r) => attempted.add(r.trackingNumber));
    }
    for (const r of found) results.set(r.trackingNumber, { provider: provider.name, result: r });
    if (result.rateLimited) break;
  }
  result.checked = attempted.size;
  result.found = results.size;
  result.remaining = Math.max(0, total - attempted.size);
  if (!attempted.size) return result;

  // Every line that uses one of the attempted numbers (within the same scope/branch).
  const lines = await db
    .select({
      id: shipments.id,
      trackingNumber: shipments.trackingNumber,
      status: shipments.status,
      shipDate: shipments.shipDate,
      actualArrivalDate: shipments.actualArrivalDate,
      arrivalSource: shipments.arrivalSource,
    })
    .from(shipments)
    .where(and(where, inArray(shipments.trackingNumber, [...attempted])));

  const now = new Date();
  const writes = [];
  const notFoundIds: number[] = [];
  for (const line of lines) {
    const hit = results.get(line.trackingNumber!);
    if (!hit) {
      notFoundIds.push(line.id);
      continue;
    }
    const update = applyTrackingResult(line, hit.result);
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
          updatedAt: now,
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
  if (notFoundIds.length) writes.push(db.update(shipments).set({ lastTrackedAt: now }).where(inArray(shipments.id, notFoundIds)));

  // One round trip, one transaction.
  if (writes.length) await db.batch(writes as [(typeof writes)[number], ...typeof writes]);
  return result;
}
