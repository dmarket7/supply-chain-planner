import { and, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { ESTIMATED_ARRIVAL_SOURCES, type RegistrationState } from '../../shared/types';
import type { Db } from '../db/client';
import { providerTrackings, shipments, trackingEvents, trackingRuns } from '../db/schema';
import { applyTrackingResult, latestEventAt, lineChanged } from './apply';
import { TrackingRateLimitError, type TrackingProvider, type TrackingRequest, type TrackingResult, type TrackingResultEvent } from './provider';

/**
 * Tracking identities per refresh call. Workers' free plan allows 50 outbound requests per
 * invocation and database queries count too: 20 identities (FedEx batches 30 per call, TrackingMore
 * 40 per courier) plus ~6 queries leaves headroom.
 */
export const REFRESH_BATCH_SIZE = 20;
/** Don't re-check a number more often than this unless forced. */
const MIN_HOURS_BETWEEN_CHECKS = 6;
/** Registrations worth syncing; the rest need registering again (or nothing more will come). */
export const SYNCABLE_STATES: readonly RegistrationState[] = ['awaiting_data', 'active', 'unavailable'];

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
  /** Tracking identities looked up in this call. */
  checked: number;
  found: number;
  linesUpdated: number;
  arrivalsConfirmed: number;
  /** Identities still due for a check after this call (call again to continue). */
  remaining: number;
  rateLimited: boolean;
  retryAfterSeconds: number | null;
  ignoredDeliveries: number;
  /** Identities the provider had no data for. */
  notFound: number;
  /** Lines whose status, dates or scans actually changed. */
  linesChanged: number;
}

/** Stable identity of a tracking event, so repeated syncs insert each scan once. */
export function eventKey(e: TrackingResultEvent): string {
  const text = [e.occurredAt, e.status, e.description?.trim().toLowerCase() ?? '', e.location?.trim().toLowerCase() ?? ''].join('|');
  // cyrb53: short, stable, good enough to tell scans apart within one shipment.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${e.occurredAt}:${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

/** Identity of a line: its registration, or (number, carrier) for direct providers. */
const identityKey = (l: { trackingNumber: string | null; carrier: string | null; trackingRegistrationId: number | null }) =>
  l.trackingRegistrationId ? `reg:${l.trackingRegistrationId}` : `num:${l.trackingNumber}|${l.carrier ?? ''}`;

function candidateFilter(opts: RefreshOptions, directCarriers: string[], registeredProviders: string[]): SQL {
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
  // Direct providers handle unregistered lines of their carriers (unless a person picked another courier);
  // registration providers handle lines linked to a syncable registration. Nothing else is looked up.
  const direct = directCarriers.length
    ? and(isNull(shipments.trackingRegistrationId), isNull(shipments.courierOverride), inArray(shipments.carrier, directCarriers))
    : undefined;
  const registered = registeredProviders.length
    ? sql`${shipments.trackingRegistrationId} in (select ${providerTrackings.id} from ${providerTrackings} where ${inArray(providerTrackings.provider, registeredProviders)} and ${inArray(providerTrackings.state, [...SYNCABLE_STATES])})`
    : undefined;
  return and(
    isNotNull(shipments.trackingNumber),
    or(direct, registered) ?? sql`false`,
    scope,
    notRecent,
    opts.branch ? eq(shipments.branch, opts.branch) : undefined,
    opts.shipmentIds?.length ? inArray(shipments.id, opts.shipmentIds) : undefined,
  )!;
}

/**
 * Looks up one batch of tracking identities and writes status, ETA, events and confirmed arrivals to
 * every line sharing each identity. Shared by the API route and (later) a cron Worker.
 */
export async function refreshTracking(db: Db, providers: TrackingProvider[], opts: RefreshOptions, now = new Date()): Promise<RefreshResult> {
  const directCarriers = [...new Set(providers.filter((p) => p.kind === 'direct').flatMap((p) => p.carriers))];
  const registeredProviders = providers.filter((p) => p.kind === 'registered').map((p) => p.name);
  const where = candidateFilter(opts, directCarriers, registeredProviders);
  const directCarrierExpr = sql`case when ${shipments.trackingRegistrationId} is null then ${shipments.carrier} end`;

  const groups = await db
    .select({
      trackingNumber: shipments.trackingNumber,
      trackingRegistrationId: shipments.trackingRegistrationId,
      carrier: sql<string | null>`min(${shipments.carrier})`,
      mode: sql<TrackingRequest['mode']>`min(${shipments.mode}::text)`,
      shipDate: sql<string | null>`min(${shipments.shipDate})`,
    })
    .from(shipments)
    .where(where)
    .groupBy(shipments.trackingNumber, shipments.trackingRegistrationId, directCarrierExpr)
    .orderBy(sql`min(${shipments.lastTrackedAt}) asc nulls first`, shipments.trackingNumber)
    .limit(REFRESH_BATCH_SIZE);

  const [{ total }] = await db
    .select({ total: sql<number>`count(distinct (${shipments.trackingNumber}, coalesce(${shipments.trackingRegistrationId}, 0), ${directCarrierExpr}))::int` })
    .from(shipments)
    .where(where);

  const result: RefreshResult = {
    checked: 0,
    found: 0,
    linesUpdated: 0,
    arrivalsConfirmed: 0,
    remaining: Math.max(0, total - groups.length),
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
        updatedAt: now,
      })
      .where(eq(trackingRuns.id, opts.runId!));
  if (!groups.length) {
    if (opts.runId) await runUpdate();
    return result;
  }

  const regIds = groups.map((g) => g.trackingRegistrationId).filter((id): id is number => !!id);
  const regs = regIds.length
    ? await db
        .select({ id: providerTrackings.id, provider: providerTrackings.provider, courierCode: providerTrackings.courierCode, registeredAt: providerTrackings.registeredAt })
        .from(providerTrackings)
        .where(inArray(providerTrackings.id, regIds))
    : [];
  const regById = new Map(regs.map((r) => [r.id, r]));
  const requests: TrackingRequest[] = groups.map((g) => {
    const reg = g.trackingRegistrationId ? regById.get(g.trackingRegistrationId) : undefined;
    return {
      trackingNumber: g.trackingNumber!,
      carrier: g.carrier,
      mode: g.mode,
      shipDate: g.shipDate,
      key: identityKey(g),
      ...(reg ? { provider: reg.provider, courierCode: reg.courierCode, registrationId: reg.id, registeredAt: reg.registeredAt } : {}),
    };
  });

  const results = new Map<string, { provider: TrackingProvider; result: TrackingResult }>();
  const attempted = new Map<string, TrackingProvider>();
  const writes = [];
  let providerError: unknown = null;
  for (const provider of providers) {
    const mine = requests.filter((r) => !attempted.has(r.key!) && provider.supports(r));
    if (!mine.length) continue;
    const keyByNumber = new Map(mine.map((r) => [r.trackingNumber, r.key!]));
    let found: TrackingResult[] = [];
    try {
      found = await provider.track(mine);
      mine.forEach((r) => attempted.set(r.key!, provider));
    } catch (err) {
      if (err instanceof TrackingRateLimitError) {
        result.rateLimited = true;
        result.retryAfterSeconds = err.retryAfterSeconds;
        found = err.partial;
        found.forEach((r) => attempted.set(r.key ?? keyByNumber.get(r.trackingNumber)!, provider));
      } else {
        // Keep everything we have; record the failure on the registrations so the UI can say so.
        providerError = err;
        const ids = mine.map((r) => r.registrationId).filter((id): id is number => !!id);
        if (ids.length) {
          const message = err instanceof Error ? err.message : String(err);
          writes.push(db.update(providerTrackings).set({ lastSyncedAt: now, lastError: message, lastErrorAt: now, updatedAt: now }).where(inArray(providerTrackings.id, ids)));
        }
        continue;
      }
    }
    for (const r of found) results.set(r.key ?? keyByNumber.get(r.trackingNumber)!, { provider, result: r });
    if (result.rateLimited) break;
  }
  result.checked = attempted.size;
  result.found = results.size;
  result.notFound = attempted.size - results.size;
  result.remaining = Math.max(0, total - attempted.size);

  // Every line of the attempted identities (within the same scope/branch).
  const attemptedNumbers = [...new Set(requests.filter((r) => attempted.has(r.key!)).map((r) => r.trackingNumber))];
  const lines = attemptedNumbers.length
    ? await db
        .select({
          id: shipments.id,
          trackingNumber: shipments.trackingNumber,
          carrier: shipments.carrier,
          trackingRegistrationId: shipments.trackingRegistrationId,
          status: shipments.status,
          shipDate: shipments.shipDate,
          estimatedArrivalDate: shipments.estimatedArrivalDate,
          actualArrivalDate: shipments.actualArrivalDate,
          arrivalSource: shipments.arrivalSource,
          lastEventAt: shipments.lastEventAt,
        })
        .from(shipments)
        .where(and(where, inArray(shipments.trackingNumber, attemptedNumbers)))
    : [];

  const notFoundIds = new Map<string, number[]>();
  const warnings = new Map<string, string>();
  for (const line of lines) {
    const key = identityKey(line);
    const provider = attempted.get(key);
    if (!provider) continue;
    const hit = results.get(key);
    if (!hit) {
      if (provider.kind === 'direct') notFoundIds.set(provider.name, [...(notFoundIds.get(provider.name) ?? []), line.id]);
      else writes.push(db.update(shipments).set({ lastTrackedAt: now }).where(eq(shipments.id, line.id)));
      continue;
    }
    const update = applyTrackingResult(line, hit.result);
    const newestEvent = latestEventAt(hit.result);
    const changed = lineChanged(line, update, newestEvent);
    if (changed) result.linesChanged++;
    if (update.ignoredDelivery) {
      result.ignoredDeliveries++;
      warnings.set(key, update.ignoredDelivery);
      console.warn(`Line ${line.id}: ${update.ignoredDelivery}`);
    }
    if (hit.result.discrepancy) warnings.set(key, hit.result.discrepancy);
    if (update.confirmedArrival) result.arrivalsConfirmed++;
    result.linesUpdated++;
    // Waiting for a first scan or tracking expired is not "found"; keep what we knew.
    const found = hit.provider.kind === 'direct' || hit.result.registrationState === 'active';
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
          trackingProvider: hit.provider.name,
          trackingFound: found ? true : sql`${shipments.trackingFound}`,
          trackedCarrier: hit.result.carrier ?? sql`${shipments.trackedCarrier}`,
          // Never move backwards when an older scan arrives late.
          lastEventAt: newestEvent ? sql`greatest(${shipments.lastEventAt}, ${new Date(newestEvent)})` : sql`${shipments.lastEventAt}`,
          ...(changed ? { trackingChangedAt: now, trackingRunId: opts.runId ?? null, updatedAt: now } : {}),
        })
        .where(eq(shipments.id, line.id)),
    );
    if (hit.result.events.length) {
      writes.push(
        db
          .insert(trackingEvents)
          .values(
            hit.result.events.map((e) => ({
              shipmentId: line.id,
              occurredAt: new Date(e.occurredAt),
              status: e.status,
              description: e.description ?? null,
              location: e.location ?? null,
              provider: hit.provider.name,
              raw: e.raw ?? null,
              eventKey: eventKey(e),
            })),
          )
          .onConflictDoNothing({ target: [trackingEvents.shipmentId, trackingEvents.provider, trackingEvents.eventKey] }),
      );
    }
  }

  // Registration bookkeeping: state and provider status for found identities; "missing" for registered
  // identities the provider no longer knows (registering again is then allowed).
  for (const req of requests) {
    if (!req.registrationId || attempted.get(req.key!)?.kind !== 'registered') continue;
    const hit = results.get(req.key!);
    if (!hit) {
      writes.push(
        db
          .update(providerTrackings)
          .set({
            state: 'missing',
            lastSyncedAt: now,
            lastError: 'TrackingMore has no record of this number (it may have been deleted there); register it again',
            lastErrorAt: now,
            updatedAt: now,
          })
          .where(eq(providerTrackings.id, req.registrationId)),
      );
      continue;
    }
    const r = hit.result;
    writes.push(
      db
        .update(providerTrackings)
        .set({
          state: r.registrationState ?? 'active',
          ...(r.providerTrackingId ? { externalId: r.providerTrackingId } : {}),
          lastSyncedAt: now,
          lastSuccessAt: now,
          lastProviderStatus: r.providerStatus ?? null,
          lastProviderSubstatus: r.providerSubstatus ?? null,
          latestEvent: r.latestEvent ?? sql`${providerTrackings.latestEvent}`,
          latestCheckpointAt: r.latestCheckpointAt ? new Date(r.latestCheckpointAt) : sql`${providerTrackings.latestCheckpointAt}`,
          lastError: null,
          lastErrorAt: null,
          lastWarning: warnings.get(req.key!) ?? null,
          updatedAt: now,
        })
        .where(eq(providerTrackings.id, req.registrationId)),
    );
  }

  // Direct-provider numbers with nothing found still count as checked, so they wait before the next try.
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
  // Results from other providers are saved above; the failure itself ends the run so it is visible.
  if (providerError) throw providerError;
  return result;
}
