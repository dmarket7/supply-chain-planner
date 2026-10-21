import { addDays } from '../../shared/dates';
import type { ShipmentStatus } from '../../shared/types';
import {
  TrackingRateLimitError,
  type TrackingProvider,
  type TrackingRequest,
  type TrackingResult,
  type TrackingResultEvent,
} from './provider';

/**
 * FedEx Track API (Basic Integrated Visibility), https://developer.fedex.com/api/en-us/catalog/track/docs.html
 * OAuth client-credentials token, then POST /track/v1/trackingnumbers with up to 30 numbers per call.
 */
export const FEDEX_URLS = {
  sandbox: 'https://apis-sandbox.fedex.com',
  production: 'https://apis.fedex.com',
} as const;
export type FedExEnvironment = keyof typeof FEDEX_URLS;

/** Numbers per Track call (FedEx's maximum). */
const MAX_PER_CALL = 30;
/**
 * Ship-date search window around the line's ETD. FedEx recommends a range "to avoid duplicates" (reused
 * numbers); the ETD comes from the supplier and can be off, so the window is generous.
 */
const SHIP_DATE_WINDOW_DAYS = { before: 30, after: 30 };

export interface FedExConfig {
  clientId: string;
  clientSecret: string;
  environment: FedExEnvironment;
}

// ─── Response shapes (the parts we use; see the Track API OpenAPI spec) ─────────────────────────────

interface FedExAddress {
  city?: string;
  stateOrProvinceCode?: string;
  countryCode?: string;
}

interface FedExScanEvent {
  date?: string;
  eventType?: string;
  eventDescription?: string;
  derivedStatusCode?: string;
  derivedStatus?: string;
  exceptionDescription?: string;
  scanLocation?: FedExAddress;
}

export interface FedExTrackResult {
  trackingNumberInfo?: { trackingNumber?: string };
  latestStatusDetail?: { code?: string; derivedCode?: string; description?: string; statusByLocale?: string };
  dateAndTimes?: { type?: string; dateTime?: string }[];
  estimatedDeliveryTimeWindow?: { type?: string; window?: { begins?: string; ends?: string } };
  scanEvents?: FedExScanEvent[];
  error?: { code?: string; message?: string };
}

interface FedExTrackResponse {
  output?: { completeTrackResults?: { trackingNumber?: string; trackResults?: FedExTrackResult[] }[] };
  errors?: { code?: string; message?: string }[];
}

// ─── Status codes ───────────────────────────────────────────────────────────────────────────────────

const CODES: Record<Exclude<ShipmentStatus, 'awaiting_shipment' | 'unknown'>, string[]> = {
  // Label created / shipment information sent to FedEx, not picked up yet.
  pending: ['OC'],
  in_transit: [
    'AA', 'AC', 'AD', 'AF', 'AP', 'AR', 'AX', 'BR', 'CC', 'CP', 'CU', 'DP', 'DR', 'DS', 'EA', 'ED', 'EO', 'EP',
    'FD', 'HL', 'HP', 'IT', 'LO', 'OF', 'OX', 'PF', 'PL', 'PM', 'PU', 'SF', 'SH', 'SP', 'TP', 'TR',
  ],
  out_for_delivery: ['OD'],
  delivered: ['DL'],
  // Delivery/shipment exceptions, cancellations and returns to the shipper.
  exception: ['CA', 'CD', 'CH', 'DD', 'DE', 'DY', 'IX', 'PD', 'PX', 'RC', 'RD', 'RG', 'RM', 'RP', 'RR', 'RS', 'LP', 'SE'],
};
const STATUS_BY_CODE = new Map(Object.entries(CODES).flatMap(([status, codes]) => codes.map((c) => [c, status as ShipmentStatus])));

export function fedexStatus(code: string | undefined): ShipmentStatus | null {
  if (!code) return null;
  return STATUS_BY_CODE.get(code.toUpperCase()) ?? 'unknown';
}

/** FedEx gives local times with an offset; a missing offset is read as UTC so the date stays right. */
function toIso(s: string | undefined): string | null {
  if (!s) return null;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const dateOnly = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined);
const place = (a: FedExAddress | undefined) =>
  [a?.city, a?.stateOrProvinceCode, a?.countryCode].filter(Boolean).join(', ') || undefined;

function shipDateOf(r: FedExTrackResult): string | undefined {
  const pick = (type: string) => dateOnly(r.dateAndTimes?.find((d) => d.type === type)?.dateTime);
  return pick('ACTUAL_PICKUP') ?? pick('SHIP') ?? pick('ACTUAL_TENDER');
}

/**
 * FedEx returns several results when a number was used more than once. Prefer the shipment that
 * started closest to the line's ship date; without one, the most recent.
 */
export function pickTrackResult(results: FedExTrackResult[], shipDate: string | null): FedExTrackResult | undefined {
  const usable = results.filter((r) => !r.error);
  if (usable.length <= 1) return usable[0];
  const time = (d: string | undefined) => (d ? Date.parse(d) : NaN);
  if (shipDate) {
    const target = Date.parse(shipDate);
    return [...usable].sort((a, b) => {
      const da = Math.abs(time(shipDateOf(a)) - target);
      const db = Math.abs(time(shipDateOf(b)) - target);
      return (Number.isNaN(da) ? Infinity : da) - (Number.isNaN(db) ? Infinity : db);
    })[0];
  }
  return [...usable].sort((a, b) => (time(shipDateOf(b)) || 0) - (time(shipDateOf(a)) || 0))[0];
}

/** One FedEx track result in the app's terms. */
export function parseFedExTrackResult(trackingNumber: string, r: FedExTrackResult): TrackingResult {
  const status = fedexStatus(r.latestStatusDetail?.derivedCode || r.latestStatusDetail?.code);
  const events: TrackingResultEvent[] = [];
  for (const e of r.scanEvents ?? []) {
    const occurredAt = toIso(e.date);
    if (!occurredAt) continue;
    events.push({
      occurredAt,
      status: fedexStatus(e.derivedStatusCode || e.eventType) ?? 'in_transit',
      description: e.eventDescription || e.derivedStatus || undefined,
      location: place(e.scanLocation),
      raw: e,
    });
  }
  const when = (type: string) => r.dateAndTimes?.find((d) => d.type === type)?.dateTime;
  // Keep FedEx's local time + offset: the arrival date is the local calendar date of delivery.
  const deliveredAt = when('ACTUAL_DELIVERY') ?? (status === 'delivered' ? r.scanEvents?.find((e) => e.eventType === 'DL')?.date : undefined);
  const window = r.estimatedDeliveryTimeWindow;
  const estimate =
    dateOnly(when('ESTIMATED_DELIVERY')) ??
    (window && (!window.type || window.type === 'ESTIMATED_DELIVERY') ? dateOnly(window.window?.begins) : undefined);
  return {
    trackingNumber,
    status,
    estimatedArrivalDate: status === 'delivered' ? undefined : estimate,
    deliveredAt: deliveredAt && toIso(deliveredAt) ? deliveredAt : undefined,
    carrier: 'FedEx',
    events,
  };
}

/** Errors meaning "FedEx has nothing for this number", as opposed to a failed call. */
const NOT_FOUND = /NOTFOUND|NOT\.FOUND|TRACKINGNUMBER\.INVALID|NOTRACKING/i;

/** Parses a Track response into results; numbers FedEx doesn't know are left out. */
export function parseFedExResponse(body: FedExTrackResponse, requests: TrackingRequest[]): TrackingResult[] {
  const byNumber = new Map(requests.map((r) => [r.trackingNumber, r]));
  const out: TrackingResult[] = [];
  for (const complete of body.output?.completeTrackResults ?? []) {
    const number = complete.trackingNumber ?? complete.trackResults?.[0]?.trackingNumberInfo?.trackingNumber;
    const req = number ? byNumber.get(number) : undefined;
    if (!req) continue;
    const chosen = pickTrackResult(complete.trackResults ?? [], req.shipDate);
    if (!chosen) continue;
    const result = parseFedExTrackResult(req.trackingNumber, chosen);
    // "Shipment information sent" with no scans and no date is as good as not found yet.
    if (result.status === null && !result.events.length) continue;
    out.push(result);
  }
  return out;
}

// ─── HTTP ───────────────────────────────────────────────────────────────────────────────────────────

/** Tokens last an hour; Workers isolates are reused between requests, so cache per isolate. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export class FedExAuthError extends Error {}

export function fedexProvider(config: FedExConfig, fetchImpl: typeof fetch = fetch): TrackingProvider {
  const baseUrl = FEDEX_URLS[config.environment];
  const cacheKey = `${baseUrl}|${config.clientId}`;

  async function getToken(forceNew = false): Promise<string> {
    const cached = tokenCache.get(cacheKey);
    if (!forceNew && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const res = await fetchImpl(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }).toString(),
    });
    if (res.status === 401 || res.status === 403 || res.status === 400) {
      throw new FedExAuthError(`FedEx rejected the client ID/secret (HTTP ${res.status}, ${config.environment})`);
    }
    if (!res.ok) throw new Error(`FedEx sign-in failed (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('FedEx sign-in returned no token');
    tokenCache.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  async function trackChunk(reqs: TrackingRequest[]): Promise<TrackingResult[]> {
    const body = JSON.stringify({
      includeDetailedScans: true,
      trackingInfo: reqs.map((r) => ({
        trackingNumberInfo: { trackingNumber: r.trackingNumber },
        ...(r.shipDate
          ? {
              shipDateBegin: addDays(r.shipDate, -SHIP_DATE_WINDOW_DAYS.before),
              shipDateEnd: addDays(r.shipDate, SHIP_DATE_WINDOW_DAYS.after),
            }
          : {}),
      })),
    });
    const call = async (token: string) =>
      fetchImpl(`${baseUrl}/track/v1/trackingnumbers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
        body,
      });
    let res = await call(await getToken());
    // An expired or revoked token: sign in again once.
    if (res.status === 401) res = await call(await getToken(true));
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after'));
      throw new TrackingRateLimitError(Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    if (res.status === 401 || res.status === 403) {
      throw new FedExAuthError(`FedEx refused the Track request (HTTP ${res.status}); check the project has the Track API`);
    }
    const parsed = (await res.json().catch(() => ({}))) as FedExTrackResponse;
    if (!res.ok) {
      // A single unknown number comes back as a top-level error rather than a per-number one.
      if (parsed.errors?.every((e) => NOT_FOUND.test(e.code ?? ''))) return [];
      const detail = parsed.errors?.map((e) => e.code).join(', ') || `HTTP ${res.status}`;
      throw new Error(`FedEx Track request failed: ${detail}`);
    }
    return parseFedExResponse(parsed, reqs);
  }

  return {
    name: 'fedex',
    carriers: ['FedEx'],
    supports: (req) => req.carrier === 'FedEx',
    async track(reqs) {
      const results: TrackingResult[] = [];
      for (let i = 0; i < reqs.length; i += MAX_PER_CALL) {
        try {
          results.push(...(await trackChunk(reqs.slice(i, i + MAX_PER_CALL))));
        } catch (err) {
          if (err instanceof TrackingRateLimitError) throw new TrackingRateLimitError(err.retryAfterSeconds, results);
          throw err;
        }
      }
      return results;
    },
  };
}

/** For tests: forget cached tokens. */
export function clearFedExTokenCache() {
  tokenCache.clear();
}
