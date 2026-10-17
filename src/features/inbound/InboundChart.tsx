import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { InboundDay } from '../../../shared/types';
import { formatDate } from '../../lib/format';

/** Fixed series so colors never shift when the date range changes. */
const SERIES = [
  { key: 'parcel', label: 'Parcel', color: 'var(--series-1)' },
  { key: 'ltl', label: 'LTL / freight', color: 'var(--series-2)' },
  { key: 'unspecified', label: 'Unspecified', color: 'var(--series-3)' },
] as const;

type Point = { date: string; total: number; parcel: number; ltl: number; unspecified: number };

function toPoints(days: InboundDay[]): Point[] {
  return days.map((d) => {
    const p: Point = { date: d.date, total: d.total, parcel: 0, ltl: 0, unspecified: 0 };
    for (const s of d.shipments) p[s.mode ?? 'unspecified']++;
    return p;
  });
}

function ChartTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as Point;
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-md dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-1 font-medium">{formatDate(p.date, { weekday: 'short' })}</div>
      {SERIES.filter((s) => p[s.key] > 0).map((s) => (
        <div key={s.key} className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          <span className="text-slate-600 dark:text-slate-300">{s.label}</span>
          <span className="ml-auto pl-4 tabular-nums">{p[s.key]}</span>
        </div>
      ))}
      <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 dark:border-slate-700">
        <span className="text-slate-500">Total</span>
        <span className="tabular-nums">{p.total}</span>
      </div>
    </div>
  );
}

export function InboundChart({ days, onSelectDay }: { days: InboundDay[]; onSelectDay?: (date: string) => void }) {
  const data = toPoints(days);
  const present = SERIES.filter((s) => data.some((p) => p[s.key] > 0));
  return (
    <div>
      {present.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {present.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => formatDate(d, { year: undefined })}
              tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
              axisLine={{ stroke: 'var(--grid)' }}
              tickLine={false}
              minTickGap={12}
            />
            <YAxis allowDecimals={false} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip content={ChartTooltip} cursor={{ fill: 'var(--grid)', opacity: 0.5 }} />
            {present.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="mode"
                fill={s.color}
                stroke="var(--surface)"
                strokeWidth={2}
                radius={i === present.length - 1 ? [4, 4, 0, 0] : 0}
                cursor={onSelectDay ? 'pointer' : undefined}
                onClick={(entry: { payload?: Point }) => entry.payload && onSelectDay?.(entry.payload.date)}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
