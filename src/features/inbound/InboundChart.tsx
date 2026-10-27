import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { InboundDay } from '../../../shared/types';
import { EstimatedHatch, ESTIMATED_FILL, Legend, tooltipBoxCls, TooltipRow as Row } from '../../components/chart';
import { formatDate, formatPallets } from '../../lib/format';

export const METRICS = ['pallets', 'units', 'lines'] as const;
export type Metric = (typeof METRICS)[number];

/** Fixed series per metric so colors never shift when the date range changes. */
const SERIES = {
  lines: [
    { key: 'parcel', label: 'Parcel', color: 'var(--series-1)' },
    { key: 'freight', label: 'Freight / forwarder', color: 'var(--series-2)' },
    { key: 'unspecified', label: 'Unspecified', color: 'var(--series-3)' },
  ],
  units: [{ key: 'units', label: 'Units', color: 'var(--series-1)' }],
  pallets: [
    { key: 'real', label: 'Real ratio', color: 'var(--series-1)' },
    { key: 'estimated', label: 'Estimated (commodity average)', color: ESTIMATED_FILL },
  ],
} as const;

type Point = { date: string; day: InboundDay } & Record<string, number | string | InboundDay>;

function toPoints(days: InboundDay[]): Point[] {
  return days.map((d) => {
    const p: Point = {
      date: d.date,
      day: d,
      parcel: 0,
      freight: 0,
      unspecified: 0,
      units: d.pallets.units,
      real: d.pallets.realPalletEq,
      estimated: d.pallets.estimatedPalletEq,
    };
    for (const s of d.shipments) (p[s.mode ?? 'unspecified'] as number)++;
    return p;
  });
}

function tooltipFor(metric: Metric) {
  return function ChartTooltip({ active, payload }: TooltipContentProps) {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload as Point;
    const { pallets } = p.day;
    return (
      <div className={tooltipBoxCls}>
        <div className="mb-1 font-medium">{formatDate(p.date, { weekday: 'short' })}</div>
        {metric === 'lines' &&
          SERIES.lines.filter((s) => (p[s.key] as number) > 0).map((s) => <Row key={s.key} color={s.color} label={s.label} value={String(p[s.key])} />)}
        {metric === 'pallets' && (
          <>
            {pallets.realPalletEq > 0 && <Row color="var(--series-1)" label="Real ratio" value={formatPallets(pallets.realPalletEq)} />}
            {pallets.estimatedPalletEq > 0 && <Row color="var(--series-1-soft)" label="Estimated" value={formatPallets(pallets.estimatedPalletEq)} />}
          </>
        )}
        <div className="mt-1 border-t border-slate-200 pt-1 dark:border-slate-700">
          {metric === 'lines' && <Row label="Total lines" value={String(p.day.total)} />}
          {metric === 'units' && <Row label="Units" value={pallets.units.toLocaleString()} />}
          {metric === 'pallets' && (
            <>
              <Row label="Pallet-equivalents" value={formatPallets(pallets.palletEq)} />
              <Row label="Full + partial pallets" value={`${pallets.fullPallets} + ${pallets.partialPallets}`} />
            </>
          )}
          {metric !== 'lines' && pallets.noRatioLines > 0 && (
            <div className="mt-1 text-xs text-red-700 dark:text-red-300">
              {pallets.noRatioLines} line{pallets.noRatioLines === 1 ? '' : 's'} with no ratio ({pallets.noRatioUnits.toLocaleString()} units)
            </div>
          )}
        </div>
      </div>
    );
  };
}

export function InboundChart({ days, metric, onSelectDay }: { days: InboundDay[]; metric: Metric; onSelectDay?: (date: string) => void }) {
  const data = toPoints(days);
  const series = SERIES[metric];
  const present = series.filter((s) => data.some((p) => (p[s.key] as number) > 0));
  return (
    <div>
      <Legend items={present} />
      <EstimatedHatch />
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
            <YAxis allowDecimals={metric === 'pallets'} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip content={tooltipFor(metric)} cursor={{ fill: 'var(--grid)', opacity: 0.5 }} />
            {present.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId={metric}
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
