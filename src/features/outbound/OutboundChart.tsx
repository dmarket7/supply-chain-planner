import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { OutboundDay } from '../../../shared/types';
import { EstimatedHatch, ESTIMATED_FILL, Legend, tooltipBoxCls, TooltipRow as Row } from '../../components/chart';
import { formatDate, formatPallets } from '../../lib/format';

export const OUTBOUND_METRICS = ['pallets', 'trucks', 'units'] as const;
export type OutboundMetric = (typeof OUTBOUND_METRICS)[number];

const SERIES = {
  pallets: [
    { key: 'real', label: 'Real ratio', color: 'var(--series-1)' },
    { key: 'estimated', label: 'Estimated', color: ESTIMATED_FILL },
  ],
  trucks: [
    { key: 'real', label: 'Truckloads, real ratios', color: 'var(--series-1)' },
    { key: 'estimated', label: 'Truckloads, estimated', color: ESTIMATED_FILL },
  ],
  units: [{ key: 'units', label: 'Units', color: 'var(--series-1)' }],
} as const;

type Point = { date: string; day: OutboundDay; real: number; estimated: number; units: number };

function toPoint(d: OutboundDay, metric: OutboundMetric): Point {
  const real = metric === 'trucks' ? d.trucks.truckloads - d.trucks.estimatedTruckloads : d.pallets.realPalletEq;
  const estimated = metric === 'trucks' ? d.trucks.estimatedTruckloads : d.pallets.estimatedPalletEq;
  return { date: d.date, day: d, real, estimated, units: d.pallets.units };
}

function ChartTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const { day } = payload[0].payload as Point;
  const { pallets, trucks } = day;
  return (
    <div className={tooltipBoxCls}>
      <div className="mb-1 font-medium">{formatDate(day.date, { weekday: 'short' })}</div>
      <Row label="Orders" value={String(day.orders)} />
      <Row label="Units" value={pallets.units.toLocaleString()} />
      <div className="mt-1 border-t border-slate-200 pt-1 dark:border-slate-700">
        <Row color="var(--series-1)" label="Pallets, real ratio" value={formatPallets(pallets.realPalletEq)} />
        {pallets.estimatedPalletEq > 0 && <Row color={ESTIMATED_FILL} label="Pallets, estimated" value={formatPallets(pallets.estimatedPalletEq)} />}
        <Row label="Full + partial pallets" value={`${pallets.fullPallets} + ${pallets.partialPallets}`} />
      </div>
      <div className="mt-1 border-t border-slate-200 pt-1 dark:border-slate-700">
        <Row label="Truckloads" value={formatPallets(trucks.truckloads)} />
        <Row label="Trucks needed" value={String(trucks.trucksNeeded)} />
      </div>
      {pallets.noRatioLines > 0 && (
        <div className="mt-1 text-xs text-red-700 dark:text-red-300">
          {pallets.noRatioLines} order{pallets.noRatioLines === 1 ? '' : 's'} with no ratio ({pallets.noRatioUnits.toLocaleString()} units)
        </div>
      )}
    </div>
  );
}

export function OutboundChart({ days, metric }: { days: OutboundDay[]; metric: OutboundMetric }) {
  const data = days.map((d) => toPoint(d, metric));
  const present = SERIES[metric].filter((s) => data.some((p) => p[s.key] > 0));
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
            <YAxis allowDecimals={metric !== 'units'} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip content={ChartTooltip} cursor={{ fill: 'var(--grid)', opacity: 0.5 }} />
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
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
