import type { ShipmentStatus } from '../../shared/types';
import {
  TrackingRateLimitError,
  type TrackingProvider,
  type TrackingRequest,
  type TrackingResult,
  type TrackingResultEvent,
} from './provider';

const API = 'https://api.ship24.com/public/v1';
/** Parallel calls per batch; keeps us polite to Ship24 and inside Workers' connection limits. */
const CONCURRENCY = 5;

/** The parts of Ship24's `tracking` object we use (see their OpenAPI spec, schema `tracking`). */
export interface Ship24Tracking {
  tracker?: { trackingNumber?: string };
  shipment?: {
    statusMilestone?: string | null;
    delivery?: {
      estimatedDeliveryDate?: string | null;
      courierEstimatedDeliveryDate?: { from?: string | null; to?: string | null } | null;
    } | null;
  } | null;
  events?: Ship24Event[] | null;
  statistics?: { timestamps?: { deliveredDatetime?: string | null } | null } | null;
}

interface Ship24Event {
  status?: string | null;
  occurrenceDatetime?: string | null;
  /** UTC version of occurrenceDatetime when the courier gave an offset. */
  datetime?: string | null;
  location?: string | null;
  courierCode?: string | null;
  statusMilestone?: string | null;
}

/** Ship24 statusMilestone -> our status. `pending` means Ship24 has no data yet. */
const MILESTONES: Record<string, ShipmentStatus | null> = {
  pending: null,
  info_received: 'in_transit',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  available_for_pickup: 'out_for_delivery',
  failed_attempt: 'exception',
  exception: 'exception',
  delivered: 'delivered',
};

function toStatus(milestone: string | null | undefined): ShipmentStatus | null {
  if (!milestone) return null;
  return milestone in MILESTONES ? MILESTONES[milestone] : 'unknown';
}

/** "2026-10-04T18:00:00" (courier-local, no offset) -> "2026-10-04". */
const dateOnly = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined);

/** "2026-10-04T17:12:57" without offset is courier-local time; store it as if UTC so the date stays right. */
function toIso(s: string): string | null {
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseShip24Tracking(trackingNumber: string, t: Ship24Tracking): TrackingResult {
  const delivery = t.shipment?.delivery;
  const events: TrackingResultEvent[] = [];
  for (const e of t.events ?? []) {
    const occurredAt = toIso(e.datetime ?? e.occurrenceDatetime ?? '');
    if (!occurredAt) continue;
    events.push({
      occurredAt,
      status: toStatus(e.statusMilestone) ?? 'in_transit',
      description: e.status ?? undefined,
      location: e.location ?? undefined,
      raw: e,
    });
  }
  const delivered = t.statistics?.timestamps?.deliveredDatetime;
  const courier = t.events?.find((e) => e.courierCode)?.courierCode ?? undefined;
  return {
    trackingNumber,
    status: toStatus(t.shipment?.statusMilestone),
    estimatedArrivalDate: dateOnly(delivery?.estimatedDeliveryDate) ?? dateOnly(delivery?.courierEstimatedDeliveryDate?.from),
    deliveredAt: delivered ? (toIso(delivered) ?? undefined) : undefined,
    carrier: courier,
    events,
  };
}

export function ship24Provider(apiKey: string, fetchImpl: typeof fetch = fetch): TrackingProvider {
  async function trackOne(req: TrackingRequest): Promise<TrackingResult | null> {
    const res = await fetchImpl(`${API}/trackers/track`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        trackingNumber: req.trackingNumber,
        ...(req.shipDate ? { shippingDate: `${req.shipDate}T00:00:00.000Z` } : {}),
      }),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after'));
      throw new TrackingRateLimitError(Number.isFinite(retry) ? retry : null);
    }
    if (res.status === 401 || res.status === 403) throw new Error(`Ship24 rejected the API key (HTTP ${res.status})`);
    if (!res.ok) {
      console.warn(`Ship24 ${res.status} for ${req.trackingNumber}`);
      return null;
    }
    const body = (await res.json()) as { data?: { trackings?: Ship24Tracking[] } };
    const tracking = body.data?.trackings?.[0];
    return tracking ? parseShip24Tracking(req.trackingNumber, tracking) : null;
  }

  return {
    name: 'ship24',
    supports: () => true,
    async track(reqs) {
      const results: TrackingResult[] = [];
      for (let i = 0; i < reqs.length; i += CONCURRENCY) {
        const settled = await Promise.allSettled(reqs.slice(i, i + CONCURRENCY).map(trackOne));
        let rateLimited: TrackingRateLimitError | null = null;
        for (const r of settled) {
          if (r.status === 'fulfilled') {
            if (r.value) results.push(r.value);
          } else if (r.reason instanceof TrackingRateLimitError) {
            rateLimited = r.reason;
          } else if (r.reason instanceof Error && r.reason.message.startsWith('Ship24 rejected')) {
            throw r.reason;
          } else {
            console.warn('Ship24 request failed', r.reason);
          }
        }
        if (rateLimited) throw new TrackingRateLimitError(rateLimited.retryAfterSeconds, results);
      }
      return results;
    },
  };
}
