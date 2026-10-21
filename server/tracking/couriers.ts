import type { LineTracking, TrackingLabel, TrackingRegistrationInfo } from '../../shared/types';

/**
 * Mapping between the app's carrier names (from the report or detected from the number) and a
 * registration provider's courier codes (TrackingMore). Codes are never hard-coded: candidates come
 * from the provider's own courier list, and a person confirms the mapping (per carrier, per
 * forwarder prefix, or per line as an override).
 */

/** Carrier values that say how goods move, not who carries them: never mapped to a courier as a whole. */
export const GENERIC_CARRIERS = new Set(['forwarder', 'truck', 'air cargo', 'unknown', 'other']);

export function isGenericCarrier(carrier: string | null | undefined): boolean {
  return !carrier || GENERIC_CARRIERS.has(carrier.trim().toLowerCase());
}

/**
 * Generic forwarder references usually start with the forwarder's or origin station's letters (HKG…, CWF…).
 * Mappings for generic carriers are made per prefix so "Forwarder · CWF" can be mapped without guessing
 * every other forwarder.
 */
export function referencePrefix(trackingNumber: string | null | undefined): string {
  return trackingNumber?.toUpperCase().match(/^[A-Z]{2,4}(?=\d)/)?.[0] ?? '';
}

/** Mapping key of a line: the carrier, plus the reference prefix for generic carriers. */
export function mappingKeyFor(carrier: string | null, trackingNumber: string | null): { carrier: string; prefix: string } {
  const c = carrier?.trim() || 'Unknown';
  return { carrier: c, prefix: isGenericCarrier(c) ? referencePrefix(trackingNumber) : '' };
}

/** Search terms per known carrier; the carrier name itself is used for any other carrier. */
const SEARCH_TERMS: Record<string, string[]> = {
  FedEx: ['fedex'],
  'FedEx Freight': ['fedex freight'],
  UPS: ['ups'],
  DHL: ['dhl'],
  DSV: ['dsv'],
  'Say Cargo': ['say cargo'],
  'JTC Express': ['jtc express', 'jtc'],
  Expeditors: ['expeditors'],
  Sinotrans: ['sinotrans'],
  'LOTTE Global Logistics': ['lotte global logistics', 'lotte'],
  'Kuehne+Nagel': ['kuehne', 'kuehne nagel'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export interface CourierOption {
  courierCode: string;
  name: string;
}

export interface CourierCandidate extends CourierOption {
  score: number;
}

export interface CandidateResult {
  candidates: CourierCandidate[];
  /** The single best match when there is one clear winner; still needs confirmation. */
  suggested: string | null;
  /** More than one plausible service (e.g. DHL Express vs DHL eCommerce): the user must pick. */
  ambiguous: boolean;
}

/** Ranks the provider's couriers against a carrier name. Never commits anything. */
export function courierCandidates(carrier: string | null, couriers: CourierOption[]): CandidateResult {
  if (isGenericCarrier(carrier)) return { candidates: [], suggested: null, ambiguous: false };
  const terms = (SEARCH_TERMS[carrier!.trim()] ?? [carrier!]).map(norm).filter(Boolean);
  const candidates: CourierCandidate[] = [];
  for (const c of couriers) {
    const name = norm(c.name || '');
    const code = norm(c.courierCode);
    let score = 0;
    for (const t of terms) {
      if (name === t || code === t) score = Math.max(score, 100);
      else if (name.startsWith(`${t} `)) score = Math.max(score, 70);
      else if (` ${name} `.includes(` ${t} `)) score = Math.max(score, 50);
      else if (code.startsWith(t)) score = Math.max(score, 40);
    }
    if (score) candidates.push({ ...c, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = candidates[0];
  const contenders = top ? candidates.filter((c) => c.score >= 70) : [];
  const ambiguous = contenders.length > 1 || (!!top && top.score < 100);
  return { candidates: candidates.slice(0, 15), suggested: top && top.score === 100 && contenders.length <= 1 ? top.courierCode : null, ambiguous };
}

export interface CarrierMappingRule {
  carrier: string;
  prefix: string;
  courierCode: string | null;
  status: 'mapped' | 'unsupported';
}

export interface ResolveContext {
  /** Carrier -> direct provider name (e.g. FedEx -> fedex); those lines never go to the registration provider. */
  directCarriers: ReadonlyMap<string, string>;
  /** Registration provider name, or null when none is enabled. */
  registrationProvider: string | null;
  mappings: CarrierMappingRule[];
  courierNames: ReadonlyMap<string, string>;
}

export interface LineForTracking {
  carrier: string | null;
  trackingNumber: string | null;
  courierOverride: string | null;
}

function findMapping(rules: CarrierMappingRule[], carrier: string, prefix: string) {
  const c = carrier.toLowerCase();
  return (
    rules.find((r) => r.carrier.toLowerCase() === c && r.prefix === prefix) ??
    (prefix ? undefined : rules.find((r) => r.carrier.toLowerCase() === c && r.prefix === ''))
  );
}

/** How one line is routed: direct provider, registration provider with a courier, or why neither. */
export function resolveLineTracking(
  line: LineForTracking,
  ctx: ResolveContext,
  registration: TrackingRegistrationInfo | null = null,
): LineTracking {
  const base = { provider: null, courierCode: null, courierName: null, courierSource: null, reason: null, registration } as const;
  const label = (l: TrackingLabel, extra: Partial<LineTracking> = {}): LineTracking => ({ ...base, label: l, ...extra });
  if (!line.trackingNumber) return label('no_tracking');

  const registered = (courierCode: string, courierSource: 'override' | 'mapping'): LineTracking => {
    const extra = { provider: ctx.registrationProvider, courierCode, courierName: ctx.courierNames.get(courierCode) ?? null, courierSource };
    if (!registration || registration.courierCode !== courierCode) return label('not_registered', { ...extra, registration: null });
    return label(labelForRegistration(registration), extra);
  };

  if (line.courierOverride && ctx.registrationProvider) return registered(line.courierOverride, 'override');
  const direct = line.carrier ? ctx.directCarriers.get(line.carrier) : undefined;
  if (direct) return label('direct', { provider: direct, courierName: line.carrier });
  if (!ctx.registrationProvider) return label('unresolved', { reason: 'No tracking provider is enabled for this carrier' });

  const key = mappingKeyFor(line.carrier, line.trackingNumber);
  const rule = findMapping(ctx.mappings, key.carrier, key.prefix);
  if (rule?.status === 'unsupported') return label('unsupported', { reason: `${describeKey(key)} is marked as not supported` });
  if (rule?.courierCode) return registered(rule.courierCode, 'mapping');
  if (isGenericCarrier(line.carrier)) {
    return label('unresolved', {
      reason: key.prefix
        ? `${describeKey(key)} is not a specific carrier; choose the courier for this prefix or this shipment`
        : `${describeKey(key)} is not a specific carrier; choose the courier for this shipment`,
    });
  }
  return label('unresolved', { reason: `${describeKey(key)} has no confirmed courier yet` });
}

export function describeKey(k: { carrier: string; prefix: string }) {
  return k.prefix ? `${k.carrier} · ${k.prefix}…` : k.carrier;
}

/** UI label for a registration; a recent API error wins so a failed sync isn't mistaken for "no data". */
export function labelForRegistration(r: TrackingRegistrationInfo): TrackingLabel {
  const errorIsLatest = r.lastErrorAt && (!r.lastSuccessAt || new Date(r.lastErrorAt) > new Date(r.lastSuccessAt));
  if (r.state === 'register_failed' || r.state === 'missing' || r.state === 'conflict' || (errorIsLatest && r.state !== 'invalid')) return 'api_error';
  switch (r.state) {
    case 'registering':
    case 'awaiting_data':
      return 'awaiting_data';
    case 'active':
      return 'active';
    case 'expired':
      return 'expired';
    case 'unavailable':
    case 'invalid':
      return 'unavailable';
  }
}
