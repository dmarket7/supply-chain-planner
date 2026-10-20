import { daysBetween } from '../../shared/dates';
import type { LineChange, LineChangeKind } from '../../shared/types';
import { STATUS_LABELS, formatDate } from './format';

const short = (d: string | null) => formatDate(d, { year: undefined });

function shift(from: string | null, to: string | null): string {
  if (!from || !to) return '';
  const d = daysBetween(from, to);
  return d === 0 ? '' : ` (${d > 0 ? '+' : ''}${d}d)`;
}

/** One change as a short phrase, e.g. "ETA Oct 15 → Oct 22 (+7d)". */
export function changeLabel(c: LineChange): string {
  switch (c.kind) {
    case 'new':
      if (c.to === 'in_transit') return 'Listed as shipped';
      if (c.to === 'delivered') return 'Listed as closed';
      return `Listed, ${c.to === 'awaiting_shipment' ? 'not shipped' : (STATUS_LABELS[c.to as keyof typeof STATUS_LABELS] ?? 'not shipped').toLowerCase()}`;
    case 'shipped':
      return c.to ? `Shipped (ASN ${c.to})` : 'Shipped';
    case 'eta_changed':
      return c.from ? `ETA ${short(c.from)} → ${short(c.to)}${shift(c.from, c.to)}` : `ETA set to ${short(c.to)}`;
    case 'ship_date_changed':
      return `Ship date ${short(c.from)} → ${short(c.to)}`;
    case 'tracking_added':
      return `Tracking added: ${c.to}`;
    case 'tracking_changed':
      return `Tracking changed: ${c.to}`;
    case 'closed':
      return c.to ? `Closed, arrived ~${short(c.to)}` : 'Closed';
    case 'reopened':
      return 'Reopened';
  }
}

/** Order used to pick the headline change of an upload for the table. */
const PRIORITY: LineChangeKind[] = ['closed', 'shipped', 'reopened', 'eta_changed', 'tracking_added', 'tracking_changed', 'ship_date_changed', 'new'];

export function headlineChange(changes: LineChange[]): LineChange | null {
  return [...changes].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind))[0] ?? null;
}

/** Dot colour per kind of change in the timeline (paired with text, never colour alone). */
export const CHANGE_DOT: Record<LineChangeKind, string> = {
  new: 'bg-slate-400',
  shipped: 'bg-blue-500',
  eta_changed: 'bg-amber-500',
  ship_date_changed: 'bg-amber-500',
  tracking_added: 'bg-blue-500',
  tracking_changed: 'bg-blue-500',
  closed: 'bg-green-600',
  reopened: 'bg-red-500',
};
