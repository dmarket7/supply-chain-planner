import type { ArrivalSource, LineTracking, Shipment, ShipmentStatus, TrackingLabel } from '../../shared/types';

export function formatDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', ...opts });
}

export const STATUS_LABELS: Record<ShipmentStatus, string> = {
  awaiting_shipment: 'Awaiting shipment',
  pending: 'Pending',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Exception',
  unknown: 'Unknown',
};

export const STATUS_STYLES: Record<ShipmentStatus, string> = {
  awaiting_shipment: 'bg-white text-slate-600 ring-1 ring-inset ring-slate-300 dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-700',
  pending: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  in_transit: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  out_for_delivery: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200',
  delivered: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  exception: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  unknown: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
};

export function varianceLabel(days: number): string {
  if (days === 0) return 'On time';
  return days > 0 ? `${days}d late` : `${-days}d early`;
}

export const ARRIVAL_SOURCE_LABELS: Record<ArrivalSource, string> = {
  tracking: 'Tracking',
  manual: 'Manual',
  import: 'Report',
  report_window: 'Est. between reports',
  eta: 'Assumed on ETA',
};

/** "Oct 3 – Oct 10" for report-window arrivals; otherwise the single date. */
export function arrivalLabel(s: Pick<Shipment, 'actualArrivalDate' | 'arrivalSource' | 'arrivalWindowStart' | 'arrivalWindowEnd'>): string {
  if (!s.actualArrivalDate) return '—';
  if (s.arrivalSource === 'report_window' && s.arrivalWindowStart && s.arrivalWindowEnd) {
    return `${formatDate(s.arrivalWindowStart, { year: undefined })} – ${formatDate(s.arrivalWindowEnd, { year: undefined })}`;
  }
  return formatDate(s.actualArrivalDate);
}

export function poLineLabel(s: { poNumber?: string | null; lineRef?: string | null }): string {
  if (!s.poNumber) return '—';
  return s.lineRef ? `${s.poNumber} / ${s.lineRef}` : s.poNumber;
}

/** Where a value came from: a carrier API lookup, a person, or the uploaded report. */
export type DataSource = 'tracking' | 'manual' | 'report';

export const DATA_SOURCE_LABELS: Record<DataSource, string> = {
  tracking: 'Carrier',
  manual: 'Manual',
  report: 'Report',
};

export const DATA_SOURCE_DESCRIPTIONS: Record<DataSource, string> = {
  tracking: 'From carrier tracking',
  manual: 'Entered manually',
  report: 'From the uploaded report',
};

/** Dot beside a value; hollow for report data so the coloured ones stand out. */
export const DATA_SOURCE_DOT: Record<DataSource, string> = {
  tracking: 'bg-cyan-500 dark:bg-cyan-400',
  manual: 'bg-orange-500 dark:bg-orange-400',
  report: 'border border-slate-400 dark:border-slate-500',
};

type SourceFields = Pick<Shipment, 'arrivalSource' | 'actualArrivalDate'>;

export function arrivalDataSource(s: SourceFields): DataSource | null {
  if (!s.actualArrivalDate) return null;
  if (s.arrivalSource === 'manual') return 'manual';
  if (s.arrivalSource === 'tracking') return 'tracking';
  return 'report';
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a date. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const mins = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d ago`;
  return formatDate(iso);
}

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

/** How a line is tracked, in words. "Awaiting data" and API errors are never shown as "not found". */
export const TRACKING_LABEL_TEXT: Record<TrackingLabel, string> = {
  no_tracking: 'No tracking number',
  direct: 'Carrier API',
  unresolved: 'Needs courier',
  unsupported: 'Not supported',
  not_registered: 'Not registered',
  awaiting_data: 'Registered · awaiting data',
  active: 'Tracking active',
  unavailable: 'Tracking unavailable',
  expired: 'Tracking expired',
  api_error: 'Tracking API error',
};

export const TRACKING_LABEL_STYLE: Record<TrackingLabel, string> = {
  no_tracking: 'text-slate-400',
  direct: 'bg-cyan-50 text-cyan-800 ring-1 ring-inset ring-cyan-200 dark:bg-cyan-950 dark:text-cyan-200 dark:ring-cyan-800',
  unresolved: 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800',
  unsupported: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  not_registered: 'text-slate-600 ring-1 ring-inset ring-slate-300 dark:text-slate-300 dark:ring-slate-700',
  awaiting_data: 'bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-800',
  active: 'bg-cyan-50 text-cyan-800 ring-1 ring-inset ring-cyan-200 dark:bg-cyan-950 dark:text-cyan-200 dark:ring-cyan-800',
  unavailable: 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
  expired: 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
  api_error: 'bg-red-50 text-red-800 ring-1 ring-inset ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-800',
};

/** Badge text for a line's tracking, naming the direct provider where there is one. */
export function trackingLabelText(t: LineTracking | undefined): string {
  if (!t) return '—';
  if (t.label === 'direct') return `${t.courierName ?? 'Carrier'} API`;
  return TRACKING_LABEL_TEXT[t.label];
}

export const PROVIDER_NAMES: Record<string, string> = { fedex: 'FedEx API', trackingmore: 'TrackingMore' };
