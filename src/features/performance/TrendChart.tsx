import { useState } from 'react';
import { CartesianGrid, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { MonthPoint } from '../../../shared/performance';
import { Legend, tooltipBoxCls, TooltipRow as Row } from '../../components/chart';
import { tableCls, tdCls, thCls } from '../../components/ui';

export interface TrendSeries {
  key: string;
  label: string;
  color: string;
  points: MonthPoint[];
}

export const monthLabel = (m: string) => new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);

type Row = Record<string, string | number | null> & { month: string };

/**
 * On-time % per month, one line per series, on one 0–100% axis. Months with no lines leave a gap.
 * A table view under the chart lists the same numbers with their line counts.
 */
export function TrendChart({ series, unit = 'lines' }: { series: TrendSeries[]; unit?: string }) {
  const [table, setTable] = useState(false);
  const months = series[0]?.points.map((p) => p.month) ?? [];
  const data = months.map((month, i) => ({
    ...Object.fromEntries(series.flatMap((s) => [[s.key, s.points[i]?.onTimePct ?? null], [`${s.key}__n`, s.points[i]?.count ?? 0]])),
    month,
  })) as Row[];
  const num = (v: string | number | null | undefined) => (typeof v === 'number' ? v : null);
  const lastWithData = (key: string) => [...data].reverse().find((d) => d[key] !== null)?.month;

  function ChartTooltip({ active, payload }: TooltipContentProps) {
    if (!active || !payload?.length) return null;
    const row = payload[0].payload as Row;
    return (
      <div className={tooltipBoxCls}>
        <div className="mb-1 font-medium">{monthLabel(row.month)}</div>
        {series.map((s) => (
          <Row key={s.key} color={s.color} label={`${s.label} · ${(num(row[`${s.key}__n`]) ?? 0).toLocaleString()} ${unit}`} value={fmtPct(num(row[s.key]))} />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Legend items={series} />
        <button onClick={() => setTable(!table)} className="ml-auto text-xs text-slate-500 hover:underline">
          {table ? 'Show chart' : 'Show as table'}
        </button>
      </div>
      {table ? (
        <div className="overflow-x-auto">
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Month</th>
                {series.map((s) => (
                  <th key={s.key} className={`${thCls} text-right`}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.month}>
                  <td className={tdCls}>{monthLabel(d.month)}</td>
                  {series.map((s) => (
                    <td key={s.key} className={`${tdCls} text-right tabular-nums`}>
                      {fmtPct(num(d[s.key]))} <span className="text-xs text-slate-500">({(num(d[`${s.key}__n`]) ?? 0).toLocaleString()})</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 12, right: 48, bottom: 0, left: -16 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} axisLine={{ stroke: 'var(--grid)' }} tickLine={false} minTickGap={8} />
              <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v: number) => `${v}%`} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip content={ChartTooltip} cursor={{ stroke: 'var(--grid)', strokeWidth: 2 }} />
              {series.map((s) => (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={{ r: 4, fill: s.color, stroke: 'var(--surface)', strokeWidth: 2 }}
                  activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2 }}
                  connectNulls={false}
                  isAnimationActive={false}
                >
                  {/* Direct label at each line's last month, so identity isn't color alone. */}
                  <LabelList
                    dataKey={s.key}
                    content={({ x, y, value, index }) =>
                      index !== undefined && data[index]?.month === lastWithData(s.key) && value !== null && value !== undefined ? (
                        <text x={Number(x) + 8} y={Number(y) + 4} fontSize={12} fill="var(--text-secondary)">
                          {fmtPct(Number(value))}
                        </text>
                      ) : null
                    }
                  />
                </Line>
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/** A small on-time % line for a table cell; gaps where a month had no lines. */
export function Sparkline({ points, color = 'var(--series-1)' }: { points: MonthPoint[]; color?: string }) {
  const w = 72;
  const h = 20;
  const step = points.length > 1 ? w / (points.length - 1) : 0;
  const y = (pct: number) => h - 2 - (pct / 100) * (h - 4);
  const segments: string[] = [];
  let current = '';
  points.forEach((p, i) => {
    if (p.onTimePct === null) {
      if (current) segments.push(current);
      current = '';
      return;
    }
    current += `${current ? 'L' : 'M'}${(i * step).toFixed(1)},${y(p.onTimePct).toFixed(1)}`;
  });
  if (current) segments.push(current);
  const title = points.map((p) => `${monthLabel(p.month)}: ${fmtPct(p.onTimePct)} (${p.count})`).join('\n');
  return (
    <svg width={w} height={h} role="img" aria-label={`On time by month: ${title.replace(/\n/g, ', ')}`}>
      <title>{title}</title>
      <line x1={0} x2={w} y1={y(100)} y2={y(100)} stroke="var(--grid)" strokeWidth={1} />
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
      ))}
      {points.map((p, i) => (p.onTimePct !== null ? <circle key={i} cx={i * step} cy={y(p.onTimePct)} r={1.5} fill={color} /> : null))}
    </svg>
  );
}
