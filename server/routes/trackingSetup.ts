import { Hono } from 'hono';
import { and, count, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { STALLED_AFTER_HOURS } from '../../shared/couriers';
import type { CoverageRow } from '../../shared/types';
import { getDb, type Db } from '../db/client';
import { carrierMappings, providerCouriers, providerTrackings, shipments } from '../db/schema';
import type { AppEnv } from '../env';
import { courierCandidates, describeKey, isGenericCarrier, mappingKeyFor, resolveLineTracking } from '../tracking/couriers';
import { TrackingRateLimitError } from '../tracking/provider';
import { getProviders, getTrackingMoreClient, trackingMoreConfig } from '../tracking/registry';
import { registerIdentities } from '../tracking/registration';
import { loadRoutingContext, MAX_RECENT_DAYS, planForScope } from '../tracking/routing';
import { TrackingMoreError, type TrackingMoreCourier } from '../tracking/trackingmore/client';
import { TRACKINGMORE } from '../tracking/trackingmore/provider';
import { branchFilter, chunk } from './common';

/**
 * TrackingMore setup: courier list, carrier coverage and mappings, per-line courier overrides,
 * registration preview and registration. Registration is the only call that uses credits, and it
 * requires `confirm: true` after the preview.
 */
export const trackingSetupRoutes = new Hono<AppEnv>();

function requireTrackingMore(env: AppEnv['Bindings']) {
  const client = getTrackingMoreClient(env);
  if (!client) {
    const state = trackingMoreConfig(env).state;
    return { error: { error: 'TrackingMore is not enabled', reason: state === 'missing_key' ? 'TRACKINGMORE_API_KEY is missing' : 'set TRACKINGMORE_ENABLED=true and TRACKINGMORE_API_KEY' } };
  }
  return { client };
}

function providerError(err: unknown) {
  if (err instanceof TrackingRateLimitError) return { status: 429 as const, body: { error: 'TrackingMore rate limit reached', reason: 'try again shortly', retryAfterSeconds: err.retryAfterSeconds } };
  if (err instanceof TrackingMoreError) return { status: 502 as const, body: { error: 'TrackingMore request failed', reason: err.message } };
  throw err;
}

async function courierExists(db: Db, code: string) {
  const [row] = await db
    .select({ code: providerCouriers.courierCode })
    .from(providerCouriers)
    .where(and(eq(providerCouriers.provider, TRACKINGMORE), eq(providerCouriers.courierCode, code)));
  return !!row;
}

// ─── Courier list ───────────────────────────────────────────────────────────────────────────────

/**
 * Upserts TrackingMore's courier list. The list can repeat a courier code (it listed `ztcce` twice in
 * Oct 2026), and one upsert can't touch the same row twice, so the first entry per code wins.
 */
export async function storeCouriers(db: Db, list: TrackingMoreCourier[], now: Date) {
  const byCode = new Map<string, TrackingMoreCourier>();
  for (const x of list) if (!byCode.has(x.courier_code)) byCode.set(x.courier_code, x);
  const rows = [...byCode.values()].map((x) => ({
    provider: TRACKINGMORE,
    courierCode: x.courier_code,
    name: x.courier_name?.trim() || x.courier_code,
    countryIso2: x.courier_country_iso2 ?? null,
    type: x.courier_type ?? null,
    url: x.courier_url ?? null,
    requiredFields: x.tracking_required_fields ?? null,
    syncedAt: now,
  }));
  const writes = chunk(rows, 500).map((part) =>
    db
      .insert(providerCouriers)
      .values(part)
      .onConflictDoUpdate({
        target: [providerCouriers.provider, providerCouriers.courierCode],
        set: {
          name: sql`excluded.name`,
          countryIso2: sql`excluded.country_iso2`,
          type: sql`excluded.type`,
          url: sql`excluded.url`,
          requiredFields: sql`excluded.required_fields`,
          syncedAt: sql`excluded.synced_at`,
        },
      }),
  );
  await db.batch(writes as [(typeof writes)[number], ...typeof writes]);
  return rows.length;
}

/** Fetches TrackingMore's supported couriers and stores them (free; no credits). */
trackingSetupRoutes.post('/couriers/sync', async (c) => {
  const tm = requireTrackingMore(c.env);
  if (tm.error) return c.json(tm.error, 503);
  let list;
  try {
    list = await tm.client.listCouriers();
  } catch (err) {
    const e = providerError(err);
    return c.json(e.body, e.status);
  }
  if (!list.length) return c.json({ error: 'TrackingMore returned no couriers' }, 502);
  const now = new Date();
  const stored = await storeCouriers(getDb(c.env.DATABASE_URL), list, now);
  return c.json({ couriers: stored, syncedAt: now.toISOString() });
});

/** Search the stored courier list (for pickers). */
trackingSetupRoutes.get('/couriers', async (c) => {
  const q = c.req.query('q')?.trim();
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select({ courierCode: providerCouriers.courierCode, name: providerCouriers.name, countryIso2: providerCouriers.countryIso2, type: providerCouriers.type })
    .from(providerCouriers)
    .where(and(eq(providerCouriers.provider, TRACKINGMORE), q ? or(ilike(providerCouriers.name, `%${q}%`), ilike(providerCouriers.courierCode, `%${q}%`)) : undefined))
    .orderBy(providerCouriers.name)
    .limit(40);
  return c.json(rows);
});

/** TrackingMore's courier detection for one number: candidates only, nothing is saved. */
trackingSetupRoutes.post('/detect', async (c) => {
  const body = z.object({ trackingNumber: z.string().trim().min(3).max(60) }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: 'Invalid tracking number' }, 400);
  const tm = requireTrackingMore(c.env);
  if (tm.error) return c.json(tm.error, 503);
  try {
    const found = await tm.client.detectCouriers(body.data.trackingNumber);
    return c.json(found.map((x) => ({ courierCode: x.courier_code, name: x.courier_name ?? x.courier_code })));
  } catch (err) {
    const e = providerError(err);
    return c.json(e.body, e.status);
  }
});

// ─── Coverage and mappings ──────────────────────────────────────────────────────────────────────

/** Carriers (and forwarder prefixes) in the data, and how each is tracked. */
trackingSetupRoutes.get('/coverage', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const providers = getProviders(c.env);
  const prefixExpr = sql<string>`coalesce(substring(upper(${shipments.trackingNumber}) from '^([A-Z]{2,4})[0-9]'), '')`;
  const groups = await db
    .select({
      carrier: shipments.carrier,
      prefix: prefixExpr,
      lines: count(),
      openLines: sql<number>`count(*) filter (where ${shipments.actualArrivalDate} is null)::int`,
      numbers: sql<number>`count(distinct ${shipments.trackingNumber})::int`,
      registeredLines: sql<number>`count(${shipments.trackingRegistrationId})::int`,
      overrideLines: sql<number>`count(${shipments.courierOverride})::int`,
      registrations: sql<number>`count(distinct ${providerTrackings.id})::int`,
      stalledRegistrations: sql<number>`count(distinct ${providerTrackings.id}) filter (where ${providerTrackings.state} = 'awaiting_data' and ${providerTrackings.latestCheckpointAt} is null and ${providerTrackings.registeredAt} < now() - make_interval(hours => ${STALLED_AFTER_HOURS}))::int`,
      // An open line's number, for "Detect" when choosing the courier.
      sampleNumber: sql<string | null>`coalesce(max(${shipments.trackingNumber}) filter (where ${shipments.actualArrivalDate} is null), max(${shipments.trackingNumber}))`,
    })
    .from(shipments)
    .leftJoin(providerTrackings, eq(providerTrackings.id, shipments.trackingRegistrationId))
    .where(and(sql`${shipments.trackingNumber} is not null`, branchFilter(c.req.query('branch'))))
    .groupBy(shipments.carrier, prefixExpr);

  const ctx = await loadRoutingContext(db, providers);
  const allCouriers = ctx.registrationProvider
    ? await db.select({ courierCode: providerCouriers.courierCode, name: providerCouriers.name }).from(providerCouriers).where(eq(providerCouriers.provider, ctx.registrationProvider))
    : [];

  const rows = new Map<string, CoverageRow>();
  for (const g of groups) {
    const key = mappingKeyFor(g.carrier, isGenericCarrier(g.carrier) && g.prefix ? `${g.prefix}0` : null);
    const id = `${key.carrier}|${key.prefix}`;
    const row = rows.get(id) ?? {
      carrier: key.carrier,
      prefix: key.prefix,
      label: describeKey(key),
      lines: 0,
      openLines: 0,
      numbers: 0,
      registeredLines: 0,
      overrideLines: 0,
      registrations: 0,
      stalledRegistrations: 0,
      sampleNumber: null,
      route: 'unresolved' as const,
      provider: null,
      courierCode: null,
      courierName: null,
      reason: null,
      candidates: [],
      suggested: null,
      ambiguous: false,
    };
    row.lines += Number(g.lines);
    row.openLines += g.openLines;
    row.numbers += g.numbers;
    row.registeredLines += g.registeredLines;
    row.overrideLines += g.overrideLines;
    row.registrations += g.registrations;
    row.stalledRegistrations += g.stalledRegistrations;
    row.sampleNumber ??= g.sampleNumber;
    rows.set(id, row);
  }
  for (const row of rows.values()) {
    const sample = row.prefix ? `${row.prefix}0` : 'X';
    const t = resolveLineTracking({ carrier: row.carrier === 'Unknown' ? null : row.carrier, trackingNumber: sample, courierOverride: null }, ctx);
    row.route = t.label === 'direct' ? 'direct' : t.label === 'unsupported' ? 'unsupported' : t.courierCode ? 'mapped' : 'unresolved';
    row.provider = t.provider;
    row.courierCode = t.courierCode;
    row.courierName = t.courierName;
    row.reason = t.reason;
    // Candidates for mapped and unsupported rows too, so the courier can be changed in place.
    if (row.route !== 'direct' && allCouriers.length) {
      const cand = courierCandidates(row.carrier, allCouriers);
      row.candidates = cand.candidates.slice(0, 8).map(({ courierCode, name }) => ({ courierCode, name }));
      row.suggested = cand.suggested;
      row.ambiguous = cand.ambiguous;
    }
  }
  const [courierInfo] = ctx.registrationProvider
    ? await db
        .select({ count: count(), syncedAt: sql<string | null>`max(${providerCouriers.syncedAt})` })
        .from(providerCouriers)
        .where(eq(providerCouriers.provider, ctx.registrationProvider))
    : [{ count: 0, syncedAt: null }];
  return c.json({
    registrationProvider: ctx.registrationProvider,
    courierList: { count: Number(courierInfo.count), syncedAt: courierInfo.syncedAt },
    rows: [...rows.values()].sort((a, b) => b.openLines - a.openLines || b.lines - a.lines),
  });
});

const mappingSchema = z.object({
  carrier: z.string().trim().min(1).max(80),
  prefix: z.string().trim().toUpperCase().max(4).default(''),
  /** null with status "unsupported" = TrackingMore can't track this carrier. */
  courierCode: z.string().trim().min(1).max(80).nullable(),
  status: z.enum(['mapped', 'unsupported']),
});

/** Confirms a carrier (or forwarder prefix) -> courier mapping, or marks it unsupported. */
trackingSetupRoutes.put('/mappings', async (c) => {
  const body = mappingSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success || (body.data.status === 'mapped') !== !!body.data.courierCode) return c.json({ error: 'Invalid mapping' }, 400);
  const { carrier, prefix, courierCode, status } = body.data;
  if (prefix && !isGenericCarrier(carrier)) return c.json({ error: 'Prefixes only apply to generic carriers such as Forwarder' }, 400);
  // A generic carrier without a prefix (unknown carrier, numeric references) covers unrelated forwarders:
  // never map it as a whole, only per shipment.
  if (!prefix && isGenericCarrier(carrier) && status === 'mapped') {
    return c.json({ error: 'Choose the courier per shipment', reason: `"${carrier}" lines without a reference prefix can belong to different carriers` }, 400);
  }
  const db = getDb(c.env.DATABASE_URL);
  if (courierCode && !(await courierExists(db, courierCode))) {
    return c.json({ error: 'Unknown courier code', reason: 'sync the TrackingMore courier list and pick a code from it' }, 400);
  }
  const now = new Date();
  // Lines of this carrier/prefix registered under a different courier get unlinked; registering again links them (free).
  const affected = and(
    carrier === 'Unknown' ? isNull(shipments.carrier) : eq(shipments.carrier, carrier),
    isNull(shipments.courierOverride),
    prefix ? ilike(shipments.trackingNumber, `${prefix}%`) : undefined,
  );
  await db.batch([
    db
      .insert(carrierMappings)
      .values({ provider: TRACKINGMORE, carrier, prefix, courierCode, status, confirmedBy: c.get('userLabel'), confirmedAt: now })
      .onConflictDoUpdate({
        target: [carrierMappings.provider, carrierMappings.carrier, carrierMappings.prefix],
        set: { courierCode, status, confirmedBy: c.get('userLabel'), confirmedAt: now },
      }),
    db
      .update(shipments)
      .set({ trackingRegistrationId: null })
      .where(
        and(
          affected,
          sql`${shipments.trackingRegistrationId} in (select id from ${providerTrackings} where ${providerTrackings.courierCode} is distinct from ${courierCode})`,
        ),
      ),
  ]);
  return c.json({ ok: true });
});

trackingSetupRoutes.delete('/mappings', async (c) => {
  const carrier = c.req.query('carrier');
  if (!carrier) return c.json({ error: 'carrier is required' }, 400);
  const db = getDb(c.env.DATABASE_URL);
  await db
    .delete(carrierMappings)
    .where(and(eq(carrierMappings.provider, TRACKINGMORE), eq(carrierMappings.carrier, carrier), eq(carrierMappings.prefix, c.req.query('prefix') ?? '')));
  return c.json({ ok: true });
});

const overrideSchema = z.object({
  shipmentId: z.number().int(),
  courierCode: z.string().trim().min(1).max(80).nullable(),
  /** Apply to every line with the same tracking number and carrier (they are the same parcel). */
  sameNumber: z.boolean().default(true),
});

/** Sets (or clears) a user-confirmed courier for a line whose carrier can't be identified reliably. */
trackingSetupRoutes.put('/override', async (c) => {
  const body = overrideSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: 'Invalid override' }, 400);
  const { shipmentId, courierCode, sameNumber } = body.data;
  const db = getDb(c.env.DATABASE_URL);
  if (courierCode && !(await courierExists(db, courierCode))) {
    return c.json({ error: 'Unknown courier code', reason: 'sync the TrackingMore courier list and pick a code from it' }, 400);
  }
  const [line] = await db.select({ trackingNumber: shipments.trackingNumber, carrier: shipments.carrier }).from(shipments).where(eq(shipments.id, shipmentId));
  if (!line) return c.json({ error: 'Not found' }, 404);
  const target =
    sameNumber && line.trackingNumber
      ? and(eq(shipments.trackingNumber, line.trackingNumber), line.carrier ? eq(shipments.carrier, line.carrier) : isNull(shipments.carrier))
      : eq(shipments.id, shipmentId);
  const updated = await db
    .update(shipments)
    .set({
      courierOverride: courierCode,
      courierOverrideBy: courierCode ? c.get('userLabel') : null,
      courierOverrideAt: courierCode ? new Date() : null,
      // The courier changed, so the old registration (if any) no longer applies; registering again relinks.
      trackingRegistrationId: null,
    })
    .where(target)
    .returning({ id: shipments.id });
  return c.json({ lines: updated.length });
});

// ─── Registration ───────────────────────────────────────────────────────────────────────────────

const scopeSchema = z.object({
  scope: z.enum(['open', 'recent', 'line']).default('open'),
  branch: z.string().nullish(),
  recentDays: z.number().int().min(1).max(MAX_RECENT_DAYS).default(30),
  shipmentIds: z.array(z.number().int()).max(500).optional(),
});

/** What registering a scope would do, before any credit is used. */
trackingSetupRoutes.post('/register/preview', async (c) => {
  const body = scopeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: 'Invalid request' }, 400);
  const db = getDb(c.env.DATABASE_URL);
  const { preview, provider } = await planForScope(db, getProviders(c.env), body.data);
  return c.json({ ...preview, enabled: !!provider });
});

/**
 * Registers up to 40 identities of the scope (call again while `remaining > 0`) and links lines to
 * existing registrations. Requires `confirm: true`: each new identity uses one TrackingMore credit.
 */
trackingSetupRoutes.post('/register', async (c) => {
  const body = scopeSchema.extend({ confirm: z.literal(true) }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: 'Invalid request', reason: 'registration needs confirm: true after reviewing the preview' }, 400);
  const tm = requireTrackingMore(c.env);
  if (tm.error) return c.json(tm.error, 503);
  const db = getDb(c.env.DATABASE_URL);
  const { identities, preview } = await planForScope(db, getProviders(c.env), body.data);
  try {
    const result = await registerIdentities(db, tm.client, TRACKINGMORE, identities, c.get('userLabel'));
    return c.json({ ...result, remaining: Math.max(0, preview.identitiesToRegister - result.submitted - result.inProgress) });
  } catch (err) {
    const e = providerError(err);
    return c.json(e.body, e.status);
  }
});

/** Lines per registration state (for the coverage page). */
trackingSetupRoutes.get('/registrations/summary', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select({ state: providerTrackings.state, identities: count() })
    .from(providerTrackings)
    .where(inArray(providerTrackings.provider, [TRACKINGMORE]))
    .groupBy(providerTrackings.state);
  return c.json(rows.map((r) => ({ state: r.state, identities: Number(r.identities) })));
});
