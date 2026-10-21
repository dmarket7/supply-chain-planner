import type { ReactNode } from 'react';
import type { LineTracking, ShipmentStatus } from '../../shared/types';
import {
  DATA_SOURCE_DESCRIPTIONS,
  DATA_SOURCE_DOT,
  DATA_SOURCE_LABELS,
  STATUS_LABELS,
  STATUS_STYLES,
  TRACKING_LABEL_STYLE,
  trackingLabelText,
  type DataSource,
} from '../lib/format';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-end gap-3">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950 ${className}`}>{children}</div>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <Card>
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </Card>
  );
}

export function StatusBadge({ status }: { status: ShipmentStatus }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>{STATUS_LABELS[status]}</span>;
}

export function DateInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-slate-500">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
      />
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">{children}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  return <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">{error instanceof Error ? error.message : 'Something went wrong'}</div>;
}

export const tableCls = 'w-full text-left text-sm';
export const thCls = 'border-b border-slate-200 px-3 py-2 font-medium text-slate-500 dark:border-slate-800';
export const tdCls = 'border-b border-slate-100 px-3 py-2 dark:border-slate-900';

/**
 * Small marker before a value saying where it came from (label for screen readers and on hover).
 * Report data is the default and gets no marker, so manual and carrier values stand out.
 */
export function SourceDot({ source }: { source: DataSource | null }) {
  if (!source || source === 'report') return null;
  return (
    <span title={DATA_SOURCE_DESCRIPTIONS[source]} className="mr-1.5 inline-flex align-middle">
      <span className={`inline-block h-2 w-2 rounded-full ${DATA_SOURCE_DOT[source]}`} aria-hidden />
      <span className="sr-only">{DATA_SOURCE_LABELS[source]}: </span>
    </span>
  );
}

/** Legend for the source markers. */
export function SourceLegend({ sources, extra }: { sources: DataSource[]; extra?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
      {sources.map((s) => (
        <span key={s} className="inline-flex items-center">
          <SourceDot source={s} />
          {DATA_SOURCE_DESCRIPTIONS[s]}
        </span>
      ))}
      {extra}
    </div>
  );
}

/** How a line is tracked (provider route / registration state). */
export function TrackingBadge({ tracking }: { tracking: LineTracking | undefined }) {
  if (!tracking || tracking.label === 'no_tracking') return <span className="text-xs text-slate-400">—</span>;
  return (
    <span
      title={tracking.reason ?? tracking.registration?.lastError ?? undefined}
      className={`inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ${TRACKING_LABEL_STYLE[tracking.label]}`}
    >
      {trackingLabelText(tracking)}
    </span>
  );
}
