import type { ArrivalSource, Shipment, ShipmentStatus } from '../../shared/types';

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
