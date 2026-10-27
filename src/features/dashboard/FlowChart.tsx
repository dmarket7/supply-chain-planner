import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { DashboardBucket } from '../../../shared/types';
import { EstimatedHatch, ESTIMATED_FILL, Legend, tooltipBoxCls, TooltipRow as Row } from '../../components/chart';
import { READINESS_GROUPS } from '../../components/readiness';
import { formatDate, formatPallets } from '../../lib/format';

export function bucketLabel(b: DashboardBucket): string {
  if (!b.from) return 'Before today';
  return `${formatDate(b.from, { year: undefined })} – ${formatDate(b.to, { year: undefined })}`;
}

const INBOUND = [
  { key: 'inReal', label: 'Inbound', color: 'var(--series-1)' },
  { key: 'inEst', label: 'Inbound, estimated', color: ESTIMATED_FILL },
] as const;
const UNKNOWN = { key: 'unknown', label: 'Outbound, no stock check', color: 'var(--unknown)' } as const;
const SERIES = [...INBOUND, ...READINESS_GROUPS, UNKNOWN];

type Point = { label: string; bucket: DashboardBucket } & Record<(typeof SERIES)[number]['key'], number>;

/** Inbound pallets go up from the axis and outbound pallets down, so a week's flow reads as one bar. */
function toPoint(b: DashboardBucket): Point {
  const { inbound, outbound } = b;
  const groups = Object.fromEntries(
    READINESS_GROUPS.map((g) => [g.key, -g.members.reduce((n, r) => n + (outbound.readiness[r]?.palletEq ?? 0), 0)]),
  ) as Record<(typeof READINESS_GROUPS)[number]['key'], number>;
  const checked = -Object.values(groups).reduce((n, v) => n + v, 0);
  return {
    label: bucketLabel(b),
    bucket: b,
    inReal: inbound.pallets.realPalletEq,
    inEst: inbound.pallets.estimatedPalletEq,
    ...groups,
    unknown: -Math.max(0, outbound.pallets.palletEq - checked),
  };
}

function ChartTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as Point;
  const { inbound, outbound } = p.bucket;
  return (
    <div className={tooltipBoxCls}>
      <div className="mb-1 font-medium">{p.label}</div>
      <Row color="var(--series-1)" label={`Inbound pallets · ${inbound.lines} lines`} value={formatPallets(inbound.pallets.palletEq)} />
      {inbound.pallets.estimatedPalletEq > 0 && <Row color={ESTIMATED_FILL} label="of which estimated" value={formatPallets(inbound.pallets.estimatedPalletEq)} />}
      <div className="mt-1 border-t border-slate-200 pt-1 dark:border-slate-700">
        <Row label={`Outbound pallets · ${outbound.orders} orders`} value={formatPallets(outbound.pallets.palletEq)} />
        {READINESS_GROUPS.map((g) => {
          const v = -p[g.key];
          return v > 0 ? <Row key={g.key} color={g.color} label={g.label} value={formatPallets(v)} /> : null;
        })}
        {p.unknown < 0 && <Row color={UNKNOWN.color} label={UNKNOWN.label} value={formatPallets(-p.unknown)} />}
        <Row label="Trucks needed" value={String(outbound.trucks.trucksNeeded)} />
      </div>
      <div className="mt-1 text-xs text-slate-500">Click for the top suppliers and sites</div>
    </div>
  );
}

export function FlowChart({ buckets, selected, onSelect }: { buckets: DashboardBucket[]; selected: string | null; onSelect: (key: string) => void }) {
  const data = buckets.map(toPoint);
  const present = SERIES.filter((s) => data.some((p) => p[s.key] !== 0));
  return (
    <div>
      <Legend items={present} />
      <EstimatedHatch />
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} stackOffset="sign" margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap="25%">
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="label" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis
              tickFormatter={(v: number) => Math.abs(v).toLocaleString()}
              tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              label={{ value: '↑ in · out ↓ (pallets)', angle: -90, position: 'insideLeft', offset: 16, fill: 'var(--text-secondary)', fontSize: 12 }}
            />
            <ReferenceLine y={0} stroke="var(--text-secondary)" />
            <Tooltip content={ChartTooltip} cursor={{ fill: 'var(--grid)', opacity: 0.5 }} />
            {present.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="flow"
                fill={s.color}
                stroke="var(--surface)"
                strokeWidth={2}
                cursor="pointer"
                onClick={(entry: { payload?: Point }) => entry.payload && onSelect(entry.payload.bucket.key)}
              >
                {data.map((p) => (
                  <Cell key={p.bucket.key} fillOpacity={selected && selected !== p.bucket.key ? 0.4 : 1} />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
