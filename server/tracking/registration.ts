import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { daysBetween } from '../../shared/dates';
import type { RegistrationState } from '../../shared/types';
import type { Db } from '../db/client';
import { providerTrackings, shipments } from '../db/schema';
import { TrackingRateLimitError } from './provider';
import {
  TM_CODES,
  TRACKINGMORE_MAX_PER_CALL,
  TrackingMoreAuthError,
  TrackingMoreError,
  TrackingMoreQuotaError,
  type TrackingMoreClient,
} from './trackingmore/client';

/**
 * Registration of tracking identities with a provider that charges per registration (TrackingMore).
 *
 * - Identity = provider + courier + tracking number + episode. One identity can cover many PO lines;
 *   the same number under another courier is another identity; a carrier reusing a number months later
 *   starts a new episode.
 * - Idempotent: the unique identity constraint plus an atomic "claim" means a retry, a double click or
 *   two users at once never send the same identity twice. If a request dies after the provider accepted
 *   it, the stale claim is retried later and the provider answers "already exists" (no second charge).
 */

/** Ship dates further apart than this are separate shipments that happen to reuse a number. */
export const EPISODE_GAP_DAYS = 120;
/** A claim older than this is considered abandoned (the request died) and may be retried. */
export const STALE_CLAIM_MINUTES = 10;
/** States in which an identity may be (re)submitted. */
export const RETRYABLE_STATES: readonly RegistrationState[] = ['register_failed', 'missing'];

export interface RegistrableLine {
  id: number;
  trackingNumber: string;
  courierCode: string;
  shipDate: string | null;
  /** Registration the line is currently linked to, if any. */
  registrationId: number | null;
}

export interface ExistingRegistration {
  id: number;
  courierCode: string;
  trackingNumber: string;
  episodeKey: string;
  anchorShipDate: string | null;
  state: RegistrationState;
  claimedAt: Date | string | null;
}

export interface PlannedIdentity {
  courierCode: string;
  trackingNumber: string;
  episodeKey: string;
  anchorShipDate: string | null;
  lineIds: number[];
  /** Lines not yet linked to this identity's registration. */
  unlinkedLineIds: number[];
  /** Matching registration already on file. */
  existing: ExistingRegistration | null;
  /** What registering needs: send to the provider, or only link lines to an existing registration. */
  action: 'submit' | 'link' | 'none';
}

const normNumber = (n: string) => n.replace(/\s+/g, '').toUpperCase();

function claimIsStale(r: ExistingRegistration, now: Date) {
  if (r.state !== 'registering') return false;
  return !r.claimedAt || now.getTime() - new Date(r.claimedAt).getTime() > STALE_CLAIM_MINUTES * 60_000;
}

/** Whether a line with this ship date belongs to an episode anchored on `anchor`. */
function inEpisode(anchor: string | null, shipDate: string | null) {
  if (!anchor || !shipDate) return true;
  return Math.abs(daysBetween(anchor, shipDate)) <= EPISODE_GAP_DAYS;
}

/**
 * Groups lines into identities and decides, per identity, whether it must be submitted (new or
 * retryable), only linked (registered already; costs nothing), or left alone.
 */
export function planRegistrations(lines: RegistrableLine[], existing: ExistingRegistration[], now = new Date()): PlannedIdentity[] {
  const byPair = new Map<string, RegistrableLine[]>();
  for (const l of lines) {
    const key = `${l.courierCode}|${normNumber(l.trackingNumber)}`;
    byPair.set(key, [...(byPair.get(key) ?? []), l]);
  }
  const out: PlannedIdentity[] = [];
  for (const [pair, group] of byPair) {
    const [courierCode, trackingNumber] = pair.split('|');
    const known = existing
      .filter((r) => r.courierCode === courierCode && normNumber(r.trackingNumber) === trackingNumber)
      .sort((a, b) => (a.anchorShipDate ?? '').localeCompare(b.anchorShipDate ?? ''));
    const identities: PlannedIdentity[] = known.map((r) => ({
      courierCode,
      trackingNumber,
      episodeKey: r.episodeKey,
      anchorShipDate: r.anchorShipDate,
      lineIds: [],
      unlinkedLineIds: [],
      existing: r,
      action: 'none',
    }));
    // Oldest ship date first, so each new episode is anchored on its earliest line.
    const sorted = [...group].sort((a, b) => (a.shipDate ?? '9999').localeCompare(b.shipDate ?? '9999'));
    for (const line of sorted) {
      const linked = line.registrationId ? identities.find((i) => i.existing?.id === line.registrationId) : undefined;
      // Prefer the closest episode by ship date; undated lines join the latest one.
      const target =
        linked ??
        [...identities]
          .filter((i) => inEpisode(i.anchorShipDate, line.shipDate))
          .sort((a, b) =>
            line.shipDate && a.anchorShipDate && b.anchorShipDate
              ? Math.abs(daysBetween(a.anchorShipDate, line.shipDate)) - Math.abs(daysBetween(b.anchorShipDate, line.shipDate))
              : (b.anchorShipDate ?? '').localeCompare(a.anchorShipDate ?? ''),
          )[0];
      if (target) {
        target.lineIds.push(line.id);
        if (!target.anchorShipDate && line.shipDate && !target.existing) {
          target.anchorShipDate = line.shipDate;
          target.episodeKey = line.shipDate;
        }
        continue;
      }
      identities.push({
        courierCode,
        trackingNumber,
        episodeKey: line.shipDate ?? 'none',
        anchorShipDate: line.shipDate,
        lineIds: [line.id],
        unlinkedLineIds: [],
        existing: null,
        action: 'submit',
      });
    }
    const linkedTo = new Map(group.map((l) => [l.id, l.registrationId]));
    for (const id of identities) {
      if (!id.lineIds.length) continue;
      id.unlinkedLineIds = id.lineIds.filter((lid) => !id.existing || linkedTo.get(lid) !== id.existing.id);
      if (!id.existing) id.action = 'submit';
      else if (RETRYABLE_STATES.includes(id.existing.state) || claimIsStale(id.existing, now)) id.action = 'submit';
      else id.action = id.unlinkedLineIds.length ? 'link' : 'none';
      out.push(id);
    }
  }
  return out;
}

// ─── Execution ──────────────────────────────────────────────────────────────────────────────────

export interface RegisterResult {
  /** Identities sent to the provider in this call. */
  submitted: number;
  registered: number;
  /** The provider already had it (e.g. a retry after a lost response): no new charge. */
  alreadyRegistered: number;
  invalid: number;
  failed: number;
  conflicts: number;
  /** Identities another request is registering right now. */
  inProgress: number;
  /** Lines linked to registrations (new or existing). */
  linesLinked: number;
  quotaExhausted: boolean;
  rateLimited: boolean;
  errors: string[];
}

const INVALID_CODES = new Set<number>([TM_CODES.invalidNumber, TM_CODES.numberRequired, TM_CODES.invalidCourier, TM_CODES.extraFieldsRequired]);

/**
 * Registers up to TRACKINGMORE_MAX_PER_CALL identities (callers loop for more) and links their lines.
 * Only identities this call manages to claim are sent, so concurrent calls can't double-register.
 */
export async function registerIdentities(
  db: Db,
  client: TrackingMoreClient,
  provider: string,
  identities: PlannedIdentity[],
  user: string,
  now = new Date(),
): Promise<RegisterResult> {
  const result: RegisterResult = {
    submitted: 0,
    registered: 0,
    alreadyRegistered: 0,
    invalid: 0,
    failed: 0,
    conflicts: 0,
    inProgress: 0,
    linesLinked: 0,
    quotaExhausted: false,
    rateLimited: false,
    errors: [],
  };
  const toSubmit = identities.filter((i) => i.action === 'submit').slice(0, TRACKINGMORE_MAX_PER_CALL);
  const toLink = identities.filter((i) => i.action === 'link');

  // 1. Claim, in two set-based statements (Workers allow ~50 subrequests per call, so never one per
  //    identity): insert new identities, and atomically take over retryable or stale ones.
  const claimed: { id: number; identity: PlannedIdentity }[] = [];
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MINUTES * 60_000);
  const identityKey = (i: { courierCode: string; trackingNumber: string; episodeKey: string }) => `${i.courierCode}|${i.trackingNumber}|${i.episodeKey}`;
  const fresh = toSubmit.filter((i) => !i.existing);
  const retry = toSubmit.filter((i) => i.existing);

  if (fresh.length) {
    const inserted = await db
      .insert(providerTrackings)
      .values(
        fresh.map((i) => ({
          provider,
          courierCode: i.courierCode,
          trackingNumber: i.trackingNumber,
          episodeKey: i.episodeKey,
          anchorShipDate: i.anchorShipDate,
          state: 'registering' as const,
          claimedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({
        id: providerTrackings.id,
        courierCode: providerTrackings.courierCode,
        trackingNumber: providerTrackings.trackingNumber,
        episodeKey: providerTrackings.episodeKey,
      });
    const insertedByKey = new Map(inserted.map((r) => [identityKey(r), r.id]));
    const lost = fresh.filter((i) => !insertedByKey.has(identityKey(i)));
    for (const i of fresh) {
      const id = insertedByKey.get(identityKey(i));
      if (id) claimed.push({ id, identity: i });
    }
    if (lost.length) {
      // Another request created these between planning and now: link the lines, don't send again.
      result.inProgress += lost.length;
      const others = await db
        .select({
          id: providerTrackings.id,
          courierCode: providerTrackings.courierCode,
          trackingNumber: providerTrackings.trackingNumber,
          episodeKey: providerTrackings.episodeKey,
        })
        .from(providerTrackings)
        .where(and(eq(providerTrackings.provider, provider), inArray(providerTrackings.trackingNumber, lost.map((i) => i.trackingNumber))));
      const otherByKey = new Map(others.map((r) => [identityKey(r), r.id]));
      for (const i of lost) {
        const id = otherByKey.get(identityKey(i));
        if (id) toLink.push({ ...i, existing: { ...i, id, state: 'registering', claimedAt: now }, action: 'link' });
      }
    }
  }
  if (retry.length) {
    const taken = await db
      .update(providerTrackings)
      .set({ state: 'registering', claimedAt: now, updatedAt: now })
      .where(
        and(
          inArray(providerTrackings.id, retry.map((i) => i.existing!.id)),
          or(
            inArray(providerTrackings.state, [...RETRYABLE_STATES]),
            and(eq(providerTrackings.state, 'registering'), sql`coalesce(${providerTrackings.claimedAt}, 'epoch') < ${staleBefore}`),
          ),
        ),
      )
      .returning({ id: providerTrackings.id });
    const takenIds = new Set(taken.map((r) => r.id));
    for (const i of retry) {
      if (takenIds.has(i.existing!.id)) claimed.push({ id: i.existing!.id, identity: i });
      else result.inProgress++;
    }
  }

  // 2. Link every line to its registration, including identities that only needed linking.
  const links = [
    ...claimed.map((c) => ({ id: c.id, lineIds: c.identity.lineIds })),
    // Identities lost to a concurrent request link all their lines; plain links only the unlinked ones.
    ...toLink.map((l) => ({ id: l.existing!.id, lineIds: l.unlinkedLineIds.length ? l.unlinkedLineIds : l.lineIds })),
  ];
  const linkWrites = links
    .filter((l) => l.lineIds.length)
    .map((l) => db.update(shipments).set({ trackingRegistrationId: l.id }).where(inArray(shipments.id, l.lineIds)));
  result.linesLinked = links.reduce((n, l) => n + l.lineIds.length, 0);
  if (linkWrites.length) await db.batch(linkWrites as [(typeof linkWrites)[number], ...typeof linkWrites]);
  if (!claimed.length) return result;

  // 3. Send the claimed identities. A single one uses create (it also returns current data).
  result.submitted = claimed.length;
  const params = claimed.map((c) => ({ tracking_number: c.identity.trackingNumber, courier_code: c.identity.courierCode }));
  type Outcome = { state: RegistrationState; externalId?: string | null; error?: string | null; warning?: string | null; registered?: boolean };
  const outcomes = new Map<number, Outcome>();
  const fail = (state: RegistrationState, error: string) => claimed.forEach((c) => outcomes.set(c.id, { state, error }));

  // Earlier registered episodes of the same numbers, to tell a harmless "already exists" from a reused number.
  const earlier = await db
    .select({ id: providerTrackings.id, courierCode: providerTrackings.courierCode, trackingNumber: providerTrackings.trackingNumber })
    .from(providerTrackings)
    .where(
      and(
        eq(providerTrackings.provider, provider),
        inArray(providerTrackings.trackingNumber, claimed.map((c) => c.identity.trackingNumber)),
        isNotNull(providerTrackings.registeredAt),
      ),
    );
  const existsOutcome = (id: number, identity: PlannedIdentity) => alreadyExistsOutcome(id, identity, earlier);

  try {
    if (claimed.length === 1) {
      const r = await client.createTracking(params[0]);
      const c = claimed[0];
      if (r.outcome === 'created') outcomes.set(c.id, { state: 'awaiting_data', externalId: r.id, registered: true });
      else outcomes.set(c.id, existsOutcome(c.id, c.identity));
    } else {
      const r = await client.batchCreate(params);
      for (const c of claimed) {
        const match = (x: { tracking_number?: string | null; courier_code?: string | null }) =>
          normNumber(x.tracking_number ?? '') === normNumber(c.identity.trackingNumber) && (!x.courier_code || x.courier_code === c.identity.courierCode);
        const ok = r.success.find(match);
        const err = r.error.find(match);
        if (ok) outcomes.set(c.id, { state: 'awaiting_data', externalId: ok.id, registered: true });
        else if (err?.errorCode === TM_CODES.alreadyExists) outcomes.set(c.id, existsOutcome(c.id, c.identity));
        else if (err && INVALID_CODES.has(err.errorCode ?? 0)) outcomes.set(c.id, { state: 'invalid', error: `${err.errorMessage ?? 'Rejected'} (${err.errorCode})` });
        else if (err?.errorCode === TM_CODES.quotaExhausted) {
          result.quotaExhausted = true;
          outcomes.set(c.id, { state: 'register_failed', error: 'TrackingMore quota used up' });
        } else outcomes.set(c.id, { state: 'register_failed', error: err ? `${err.errorMessage ?? 'Rejected'} (${err.errorCode})` : 'No answer for this number' });
      }
    }
  } catch (err) {
    if (err instanceof TrackingRateLimitError) {
      result.rateLimited = true;
      fail('register_failed', 'TrackingMore rate limit reached; try again shortly');
    } else if (err instanceof TrackingMoreQuotaError) {
      result.quotaExhausted = true;
      fail('register_failed', err.message);
    } else if (err instanceof TrackingMoreError) {
      fail('register_failed', err.message);
      result.errors.push(err.message);
      if (err instanceof TrackingMoreAuthError) {
        await writeOutcomes(db, outcomes, user, now);
        throw err;
      }
    } else {
      fail('register_failed', err instanceof Error ? err.message : String(err));
      await writeOutcomes(db, outcomes, user, now);
      throw err;
    }
  }

  for (const o of outcomes.values()) {
    if (o.state === 'invalid') result.invalid++;
    else if (o.state === 'conflict') result.conflicts++;
    else if (o.state === 'register_failed') result.failed++;
    else if (o.registered) result.registered++;
    else result.alreadyRegistered++;
  }
  await writeOutcomes(db, outcomes, user, now);
  return result;
}

/**
 * "Already exists" at the provider. Normally a harmless retry. But if we hold an older registered
 * episode of the same number with this courier, the provider's record is that older shipment: flag it as
 * a conflict rather than mixing the two shipments.
 */
export function alreadyExistsOutcome(
  id: number,
  identity: Pick<PlannedIdentity, 'courierCode' | 'trackingNumber'>,
  registered: { id: number; courierCode: string; trackingNumber: string }[],
): { state: RegistrationState; error?: string; warning?: string } {
  const older = registered.find((r) => r.id !== id && r.courierCode === identity.courierCode && normNumber(r.trackingNumber) === normNumber(identity.trackingNumber));
  if (older) {
    return {
      state: 'conflict',
      error: 'TrackingMore already tracks an earlier shipment with this reused number; remove the old tracking in TrackingMore, then register again',
    };
  }
  return { state: 'awaiting_data', warning: 'Already registered at TrackingMore (no new credit used)' };
}

async function writeOutcomes(
  db: Db,
  outcomes: Map<number, { state: RegistrationState; externalId?: string | null; error?: string | null; warning?: string | null }>,
  user: string,
  now: Date,
) {
  const writes = [...outcomes].map(([id, o]) =>
    db
      .update(providerTrackings)
      .set({
        state: o.state,
        claimedAt: null,
        ...(o.externalId ? { externalId: o.externalId } : {}),
        ...(o.state === 'awaiting_data' ? { registeredAt: sql`coalesce(${providerTrackings.registeredAt}, ${now})`, registeredBy: sql`coalesce(${providerTrackings.registeredBy}, ${user})` } : {}),
        lastError: o.error ?? null,
        lastErrorAt: o.error ? now : null,
        lastWarning: o.warning ?? null,
        updatedAt: now,
      })
      .where(eq(providerTrackings.id, id)),
  );
  if (writes.length) await db.batch(writes as [(typeof writes)[number], ...typeof writes]);
}
