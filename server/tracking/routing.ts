import { and, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { addDays, todayIso } from '../../shared/dates';
import { ESTIMATED_ARRIVAL_SOURCES, type LineTracking, type RegistrationState, type TrackingRegistrationInfo } from '../../shared/types';
import type { Db } from '../db/client';
import { carrierMappings, providerCouriers, providerTrackings, shipments } from '../db/schema';
import { branchFilter } from '../routes/common';
import { describeKey, mappingKeyFor, resolveLineTracking, type CarrierMappingRule, type ResolveContext } from './couriers';
import type { TrackingProvider } from './provider';
import { planRegistrations, type PlannedIdentity, type RegistrableLine } from './registration';
import { directCarrierMap } from './registry';

/** Columns of a registration as shown to the UI. */
export const registrationColumns = {
  id: providerTrackings.id,
  provider: providerTrackings.provider,
  courierCode: providerTrackings.courierCode,
  state: providerTrackings.state,
  registeredAt: providerTrackings.registeredAt,
  lastSyncedAt: providerTrackings.lastSyncedAt,
  lastSuccessAt: providerTrackings.lastSuccessAt,
  lastProviderStatus: providerTrackings.lastProviderStatus,
  lastProviderSubstatus: providerTrackings.lastProviderSubstatus,
  latestEvent: providerTrackings.latestEvent,
  latestCheckpointAt: providerTrackings.latestCheckpointAt,
  lastError: providerTrackings.lastError,
  lastErrorAt: providerTrackings.lastErrorAt,
  lastWarning: providerTrackings.lastWarning,
};

type RegistrationRow = { [K in keyof typeof registrationColumns]: unknown };

export function toRegistrationInfo(r: RegistrationRow): TrackingRegistrationInfo {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);
  return {
    id: r.id as number,
    provider: r.provider as string,
    courierCode: r.courierCode as string,
    state: r.state as RegistrationState,
    registeredAt: iso(r.registeredAt),
    lastSyncedAt: iso(r.lastSyncedAt),
    lastSuccessAt: iso(r.lastSuccessAt),
    lastProviderStatus: (r.lastProviderStatus as string | null) ?? null,
    lastProviderSubstatus: (r.lastProviderSubstatus as string | null) ?? null,
    latestEvent: (r.latestEvent as string | null) ?? null,
    latestCheckpointAt: iso(r.latestCheckpointAt),
    lastError: (r.lastError as string | null) ?? null,
    lastErrorAt: iso(r.lastErrorAt),
    lastWarning: (r.lastWarning as string | null) ?? null,
  };
}

/** Routing context: direct carriers, the registration provider, confirmed mappings and courier names. */
export async function loadRoutingContext(db: Db, providers: TrackingProvider[], extraCodes: string[] = []): Promise<ResolveContext> {
  const registration = providers.find((p) => p.kind === 'registered')?.name ?? null;
  const mappings: CarrierMappingRule[] = registration
    ? await db
        .select({ carrier: carrierMappings.carrier, prefix: carrierMappings.prefix, courierCode: carrierMappings.courierCode, status: carrierMappings.status })
        .from(carrierMappings)
        .where(eq(carrierMappings.provider, registration))
    : [];
  const codes = [...new Set([...mappings.map((m) => m.courierCode), ...extraCodes].filter((c): c is string => !!c))];
  const names = registration && codes.length
    ? await db
        .select({ code: providerCouriers.courierCode, name: providerCouriers.name })
        .from(providerCouriers)
        .where(and(eq(providerCouriers.provider, registration), inArray(providerCouriers.courierCode, codes)))
    : [];
  return {
    directCarriers: directCarrierMap(providers),
    registrationProvider: registration,
    mappings,
    courierNames: new Map(names.map((n) => [n.code, n.name])),
  };
}

export interface TrackableLine {
  id: number;
  trackingNumber: string | null;
  carrier: string | null;
  courierOverride: string | null;
  shipDate: string | null;
  trackingRegistrationId: number | null;
}

/** Adds `tracking` (route, courier, registration) to shipment rows for the UI. */
export async function attachTracking<T extends TrackableLine>(db: Db, providers: TrackingProvider[], rows: T[]): Promise<(T & { tracking: LineTracking })[]> {
  const regIds = [...new Set(rows.map((r) => r.trackingRegistrationId).filter((id): id is number => !!id))];
  const regs = regIds.length ? await db.select(registrationColumns).from(providerTrackings).where(inArray(providerTrackings.id, regIds)) : [];
  const regById = new Map(regs.map((r) => [r.id, toRegistrationInfo(r)]));
  const ctx = await loadRoutingContext(db, providers, [
    ...rows.map((r) => r.courierOverride).filter((c): c is string => !!c),
    ...regs.map((r) => r.courierCode),
  ]);
  return rows.map((r) => ({
    ...r,
    tracking: resolveLineTracking(r, ctx, r.trackingRegistrationId ? (regById.get(r.trackingRegistrationId) ?? null) : null),
  }));
}

// ─── Registration preview ───────────────────────────────────────────────────────────────────────

export type RegistrationScope = 'open' | 'recent' | 'line';

export interface ScopeOptions {
  scope: RegistrationScope;
  branch?: string | null;
  /** For `recent`: arrived (estimated) within this many days. */
  recentDays?: number;
  shipmentIds?: number[];
}

/** Recent arrivals are capped so a click can't register the whole history. */
export const MAX_RECENT_DAYS = 90;

function scopeFilter(o: ScopeOptions): SQL | undefined {
  if (o.scope === 'line') return o.shipmentIds?.length ? inArray(shipments.id, o.shipmentIds) : sql`false`;
  if (o.scope === 'recent') {
    const days = Math.min(Math.max(o.recentDays ?? 30, 1), MAX_RECENT_DAYS);
    return and(
      inArray(shipments.arrivalSource, [...ESTIMATED_ARRIVAL_SOURCES]),
      gte(shipments.actualArrivalDate, addDays(todayIso(), -days)),
    );
  }
  return isNull(shipments.actualArrivalDate);
}

export interface RegistrationPreview {
  linesConsidered: number;
  /** Unique identities that would be sent to the provider (= credits). */
  identitiesToRegister: number;
  linesToRegister: number;
  /** Lines whose identity is already registered and only needs linking (free). */
  linesToLink: number;
  alreadyRegisteredIdentities: number;
  directLines: number;
  unresolvedLines: number;
  unsupportedLines: number;
  byCourier: { courierCode: string; courierName: string | null; identities: number; lines: number }[];
  unresolved: { key: string; lines: number; reason: string }[];
}

export async function planForScope(db: Db, providers: TrackingProvider[], o: ScopeOptions, now = new Date()) {
  const rows = await db
    .select({
      id: shipments.id,
      trackingNumber: shipments.trackingNumber,
      carrier: shipments.carrier,
      courierOverride: shipments.courierOverride,
      shipDate: shipments.shipDate,
      trackingRegistrationId: shipments.trackingRegistrationId,
    })
    .from(shipments)
    .where(and(isNotNull(shipments.trackingNumber), scopeFilter(o), branchFilter(o.branch ?? undefined)));
  const ctx = await loadRoutingContext(db, providers, rows.map((r) => r.courierOverride).filter((c): c is string => !!c));
  const provider = ctx.registrationProvider;

  const registrable: RegistrableLine[] = [];
  const preview: RegistrationPreview = {
    linesConsidered: rows.length,
    identitiesToRegister: 0,
    linesToRegister: 0,
    linesToLink: 0,
    alreadyRegisteredIdentities: 0,
    directLines: 0,
    unresolvedLines: 0,
    unsupportedLines: 0,
    byCourier: [],
    unresolved: [],
  };
  const unresolved = new Map<string, { lines: number; reason: string }>();
  for (const r of rows) {
    const t = resolveLineTracking(r, ctx);
    if (t.label === 'direct') preview.directLines++;
    else if (t.label === 'unsupported') preview.unsupportedLines++;
    else if (t.label === 'unresolved') {
      preview.unresolvedLines++;
      const key = describeKey(mappingKeyFor(r.carrier, r.trackingNumber));
      unresolved.set(key, { lines: (unresolved.get(key)?.lines ?? 0) + 1, reason: t.reason ?? '' });
    } else if (t.courierCode) {
      registrable.push({ id: r.id, trackingNumber: r.trackingNumber!, courierCode: t.courierCode, shipDate: r.shipDate, registrationId: r.trackingRegistrationId });
    }
  }

  const numbers = [...new Set(registrable.map((l) => l.trackingNumber.replace(/\s+/g, '').toUpperCase()))];
  const existing = provider && numbers.length
    ? await db
        .select({
          id: providerTrackings.id,
          courierCode: providerTrackings.courierCode,
          trackingNumber: providerTrackings.trackingNumber,
          episodeKey: providerTrackings.episodeKey,
          anchorShipDate: providerTrackings.anchorShipDate,
          state: providerTrackings.state,
          claimedAt: providerTrackings.claimedAt,
        })
        .from(providerTrackings)
        .where(and(eq(providerTrackings.provider, provider), inArray(providerTrackings.trackingNumber, numbers)))
    : [];
  const identities: PlannedIdentity[] = planRegistrations(
    registrable.map((l) => ({ ...l, trackingNumber: l.trackingNumber.replace(/\s+/g, '').toUpperCase() })),
    existing,
    now,
  );

  const byCourier = new Map<string, { identities: number; lines: number }>();
  for (const i of identities) {
    if (i.action === 'submit') {
      preview.identitiesToRegister++;
      preview.linesToRegister += i.lineIds.length;
      const c = byCourier.get(i.courierCode) ?? { identities: 0, lines: 0 };
      byCourier.set(i.courierCode, { identities: c.identities + 1, lines: c.lines + i.lineIds.length });
    } else {
      preview.alreadyRegisteredIdentities++;
      if (i.action === 'link') preview.linesToLink += i.unlinkedLineIds.length;
    }
  }
  preview.byCourier = [...byCourier]
    .map(([courierCode, v]) => ({ courierCode, courierName: ctx.courierNames.get(courierCode) ?? null, ...v }))
    .sort((a, b) => b.identities - a.identities);
  preview.unresolved = [...unresolved].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.lines - a.lines);
  return { preview, identities, provider };
}
