import { dateShift, ORDER_CAUSE_LABELS, ORDER_CHANGE_LABELS, type OrderChangeKind } from '../../shared/orderChanges';
import type { OrderChangeRow } from '../../shared/types';
import { formatDate } from './format';

const DATE_KINDS: OrderChangeKind[] = ['confirmed_date', 'dock_date', 'scheduled_date'];
/** Which change a table cell leads with. */
const PRIORITY: OrderChangeKind[] = ['new', 'confirmed_date', 'dock_date', 'quantity', 'status', 'scheduled_date', 'gone'];

const short = (iso: string | null) => (iso ? formatDate(iso, { year: undefined }) : 'none');
const signedDays = (n: number) => `${n > 0 ? '+' : ''}${n}d`;

/** "Confirmed ship date Nov 2 → Nov 16 (+14d)". */
export function describeChange(c: OrderChangeRow): string {
  const label = ORDER_CHANGE_LABELS[c.kind];
  if (c.kind === 'new') return `New order, ${Number(c.to).toLocaleString()} units`;
  if (c.kind === 'gone') return 'No longer listed (shipped or cancelled)';
  if (DATE_KINDS.includes(c.kind)) {
    const shift = dateShift(c);
    return `${label} ${short(c.from)} → ${short(c.to)}${shift !== null ? ` (${signedDays(shift)})` : ''}`;
  }
  if (c.kind === 'quantity') return `${label} ${Number(c.from).toLocaleString()} → ${Number(c.to).toLocaleString()}`;
  return `${label}: ${c.from || 'none'} → ${c.to || 'none'}`;
}

/** "customer moved the dock date, reservation changed", or the report shows no cause. */
export function describeCauses(c: OrderChangeRow): string | null {
  if (!DATE_KINDS.includes(c.kind) || c.kind === 'dock_date') return null;
  return c.causes.length ? c.causes.map((k) => ORDER_CAUSE_LABELS[k]).join(', ') : 'no cause in the report';
}

export function leadChange(changes: OrderChangeRow[]): OrderChangeRow | null {
  return [...changes].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind))[0] ?? null;
}

/** Days the confirmed ship date moved, for sorting: positive = later. */
export function shipDateShift(changes: OrderChangeRow[]): number | null {
  const c = changes.find((x) => x.kind === 'confirmed_date');
  return c ? dateShift(c) : null;
}
