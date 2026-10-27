import { READINESS_LABELS, type Readiness } from '../../shared/supply';
import { formatDate } from '../lib/format';

/** Chart groups: the six readiness states fold into four colors, best to worst. */
export const READINESS_GROUPS = [
  { key: 'canShip', label: 'Can ship', color: 'var(--ready)', members: ['ready', 'stock'] },
  { key: 'waiting', label: 'Waiting on inbound', color: 'var(--waiting)', members: ['inbound', 'noEta'] },
  { key: 'late', label: 'Inbound late', color: 'var(--late)', members: ['late'] },
  { key: 'short', label: 'Short', color: 'var(--short)', members: ['short'] },
] as const satisfies readonly { key: string; label: string; color: string; members: readonly Readiness[] }[];

const BADGE: Record<Readiness, string> = {
  ready: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  stock: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  inbound: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  noEta: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  late: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  short: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};

export interface ReadinessDetail {
  readiness: Readiness | null;
  coveredBy: string | null;
  supplierShipDate: string | null;
  shortUnits: number;
}

/** Why an order is in its state, in a few words. */
export function readinessReason(s: ReadinessDetail, shipDate: string | null): string {
  const d = (iso: string | null) => formatDate(iso, { year: undefined });
  switch (s.readiness) {
    case 'ready':
      return 'Stock reserved';
    case 'stock':
      return 'Free stock covers it';
    case 'inbound':
      return `Inbound ETA ${d(s.coveredBy)}`;
    case 'noEta':
      return s.supplierShipDate ? `No ETA yet; supplier ships ${d(s.supplierShipDate)}` : 'Inbound has no ETA yet';
    case 'late':
      return s.coveredBy && (!s.supplierShipDate || s.coveredBy >= s.supplierShipDate)
        ? `Inbound ETA ${d(s.coveredBy)}, after ship date ${d(shipDate)}`
        : `Supplier ships ${d(s.supplierShipDate)}, after ship date ${d(shipDate)}`;
    case 'short':
      return `${s.shortUnits.toLocaleString()} units with no stock or inbound`;
    default:
      return '';
  }
}

export function ReadinessBadge({ detail, shipDate }: { detail: ReadinessDetail; shipDate: string | null }) {
  if (!detail.readiness) return <span className="text-slate-400">—</span>;
  return (
    <span title={readinessReason(detail, shipDate)} className={`inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ${BADGE[detail.readiness]}`}>
      {READINESS_LABELS[detail.readiness]}
    </span>
  );
}

/** Thin stacked bar of units by readiness group. */
export function ReadinessBar({ readiness }: { readiness: Partial<Record<Readiness, { units: number }>> }) {
  const groups = READINESS_GROUPS.map((g) => ({ ...g, units: g.members.reduce((n, r) => n + (readiness[r]?.units ?? 0), 0) }));
  const total = groups.reduce((n, g) => n + g.units, 0);
  if (!total) return null;
  return (
    <div className="flex h-2 w-24 gap-px overflow-hidden rounded-full" role="img" aria-label={groups.filter((g) => g.units).map((g) => `${g.label} ${Math.round((g.units / total) * 100)}%`).join(', ')}>
      {groups.filter((g) => g.units).map((g) => (
        <span key={g.key} title={`${g.label}: ${g.units.toLocaleString()} units`} style={{ width: `${(g.units / total) * 100}%`, background: g.color }} />
      ))}
    </div>
  );
}
