import type { OnTime, SupplierStatus } from '../../../shared/performance';
import { SUPPLIER_STATUS_LABELS } from '../../../shared/performance';

export const PERIOD_OPTIONS = [
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: '6 months' },
  { value: '365', label: '12 months' },
];

export const pctText = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);
export const daysText = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}d`);

/** "62% · 130 lines" style hint, with the change from the period before when both have data. */
export function onTimeHint(now: OnTime, before: OnTime | null, unit = 'lines'): string {
  const base = `${now.count.toLocaleString()} ${unit}`;
  if (!before || before.onTimePct === null || now.onTimePct === null) return base;
  const d = Math.round(now.onTimePct - before.onTimePct);
  return `${base} · ${d > 0 ? '+' : ''}${d} pts vs the period before`;
}

const STATUS_STYLE: Record<SupplierStatus, string> = {
  consistently_late: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  getting_worse: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  reliable: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
};
const STATUS_ICON: Record<SupplierStatus, string> = { consistently_late: '▲', getting_worse: '↗', reliable: '✓' };
const STATUS_HINT: Record<SupplierStatus, string> = {
  consistently_late: 'At least half its arrivals were late in each of the last three months with five or more arrivals',
  getting_worse: 'Late share in the last 30 days is 20+ points above the 90 days before',
  reliable: '90% or more on time, on at least ten arrivals',
};

export function SupplierStatusBadge({ status }: { status: SupplierStatus | null }) {
  if (!status) return <span className="text-xs text-slate-400">—</span>;
  return (
    <span title={STATUS_HINT[status]} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>
      <span aria-hidden>{STATUS_ICON[status]}</span>
      {SUPPLIER_STATUS_LABELS[status]}
    </span>
  );
}

/** Late counts in red, on time in the default ink. */
export function DaysLate({ days }: { days: number | null }) {
  if (days === null) return <span className="text-slate-400">—</span>;
  if (days <= 0) return <span className="text-slate-500">{days === 0 ? 'on time' : `${-days}d early`}</span>;
  return <span className="font-medium text-red-700 dark:text-red-300">{days}d late</span>;
}
