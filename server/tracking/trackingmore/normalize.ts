import type { RegistrationState, ShipmentStatus } from '../../../shared/types';
import type { TrackingResult, TrackingResultEvent } from '../provider';
import type { TrackingMoreCheckpoint, TrackingMoreTracking } from './client';

/**
 * TrackingMore delivery_status -> app status. null = no usable information: keep the line's status.
 * `pending` only means something once the carrier has posted scans; `notfound` and `expired` say nothing
 * about the parcel itself, so they never turn a line into an exception.
 */
const STATUS: Record<string, ShipmentStatus | null> = {
  inforeceived: 'pending',
  pending: null,
  transit: 'in_transit',
  pickup: 'out_for_delivery',
  delivered: 'delivered',
  undelivered: 'exception',
  exception: 'exception',
  notfound: null,
  expired: null,
};

export function trackingMoreStatus(status: string | null | undefined, hasCheckpoints = false): ShipmentStatus | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s === 'pending') return hasCheckpoints ? 'pending' : null;
  return s in STATUS ? STATUS[s] : null;
}

/** After this long without any data, a registration is shown as "Tracking unavailable" instead of "awaiting data". */
export const UNAVAILABLE_AFTER_DAYS = 14;

export function registrationStateFor(
  status: string | null | undefined,
  hasCheckpoints: boolean,
  registeredAt: Date | string | null | undefined,
  now = new Date(),
): RegistrationState {
  const s = status?.toLowerCase() ?? '';
  if (s === 'expired') return 'expired';
  const noData = !hasCheckpoints && (s === '' || s === 'notfound' || s === 'pending');
  if (!noData) return 'active';
  const age = registeredAt ? (now.getTime() - new Date(registeredAt).getTime()) / 86_400_000 : 0;
  return age > UNAVAILABLE_AFTER_DAYS ? 'unavailable' : 'awaiting_data';
}

export interface ParsedTime {
  /** UTC instant for storage and ordering. A zoneless value is read as UTC so its date doesn't shift. */
  iso: string;
  /** The carrier's own wall-clock value ("YYYY-MM-DDTHH:mm:ss" plus its offset when given); date part = local date. */
  local: string;
}

/**
 * TrackingMore timestamps: ISO with offset on top-level fields, and zoneless ISO ("2026-05-21T10:53:51")
 * or space-separated ("2015-11-02 17:11") on checkpoints; dates alone on some fields.
 */
export function parseTrackingMoreTime(value: string | null | undefined): ParsedTime | null {
  const s = value?.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return null;
  const [, date, hm, sec, zone] = m;
  const local = `${date}T${hm ?? '00:00'}${sec ?? ':00'}${zone ? (zone.toUpperCase() === 'Z' ? 'Z' : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone) : ''}`;
  const d = new Date(zone ? local : `${local}Z`);
  if (Number.isNaN(d.getTime())) return null;
  return { iso: d.toISOString(), local };
}

const dateOnly = (v: string | null | undefined) => parseTrackingMoreTime(v)?.local.slice(0, 10);

function place(c: TrackingMoreCheckpoint): string | undefined {
  const parts = [c.city, c.state, c.country_iso2].filter(Boolean);
  return c.location?.trim() || parts.join(', ') || undefined;
}

export interface ParseOptions {
  registeredAt?: Date | string | null;
  now?: Date;
}

/** One TrackingMore tracking in the app's terms (plus provider details kept for troubleshooting). */
export function parseTrackingMoreTracking(t: TrackingMoreTracking, opts: ParseOptions = {}): TrackingResult & { undatedCheckpoints: number } {
  const checkpoints = [...(t.origin_info?.trackinfo ?? []), ...(t.destination_info?.trackinfo ?? [])];
  const events: TrackingResultEvent[] = [];
  const seen = new Set<string>();
  let undatedCheckpoints = 0;
  for (const c of checkpoints) {
    const time = parseTrackingMoreTime(c.checkpoint_date);
    if (!time) {
      // Without a time an event can't be ordered or deduplicated reliably; it is left out, not invented.
      undatedCheckpoints++;
      continue;
    }
    const description = c.tracking_detail?.trim() || undefined;
    // The same checkpoint can appear in both the origin and destination legs.
    const dedupe = `${time.iso}|${description ?? ''}|${c.checkpoint_delivery_status ?? ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    events.push({
      occurredAt: time.iso,
      status: trackingMoreStatus(c.checkpoint_delivery_status, true) ?? 'in_transit',
      description,
      location: place(c),
      raw: c,
    });
  }
  events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const hasCheckpoints = events.length > 0 || undatedCheckpoints > 0;
  const status = trackingMoreStatus(t.delivery_status, hasCheckpoints);
  let deliveredAt: string | undefined;
  let discrepancy: string | null = null;
  if (status === 'delivered') {
    // Trust only an explicit delivery time: the delivery milestone, else the "delivered" checkpoint.
    const milestone =
      parseTrackingMoreTime(t.destination_info?.milestone_date?.delivery_date) ??
      parseTrackingMoreTime(t.origin_info?.milestone_date?.delivery_date);
    const deliveredCheckpoint = checkpoints
      .filter((c) => c.checkpoint_delivery_status?.toLowerCase() === 'delivered')
      .map((c) => parseTrackingMoreTime(c.checkpoint_date))
      .filter((x): x is ParsedTime => !!x)
      .sort((a, b) => b.iso.localeCompare(a.iso))[0];
    deliveredAt = (milestone ?? deliveredCheckpoint)?.local;
    if (!deliveredAt) discrepancy = 'TrackingMore reports delivered but gives no delivery time; arrival date left unchanged';
  }

  return {
    trackingNumber: t.tracking_number,
    status,
    estimatedArrivalDate: status === 'delivered' ? undefined : dateOnly(t.scheduled_delivery_date),
    deliveredAt,
    carrier: t.courier_code ?? undefined,
    events,
    providerStatus: t.delivery_status ?? null,
    providerSubstatus: t.substatus ?? null,
    latestEvent: t.latest_event ?? events[0]?.description ?? null,
    latestCheckpointAt: parseTrackingMoreTime(t.latest_checkpoint_time)?.iso ?? events[0]?.occurredAt ?? null,
    providerTrackingId: t.id ?? null,
    registrationState: registrationStateFor(t.delivery_status, hasCheckpoints, opts.registeredAt ?? t.created_at, opts.now),
    discrepancy,
    undatedCheckpoints,
  };
}
