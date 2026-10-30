import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import { AGE_BUCKETS, type PastDuePoint } from '../../../shared/performance';
import type { PastDueLine, ReceivingResponse } from '../../../shared/types';
import { Legend, tooltipBoxCls, TooltipRow as Row } from '../../components/chart';
import { DataTable, type Column } from '../../components/DataTable';
import { Card, Empty, ErrorNote, StatTile, StatusBadge, tableCls, tdCls, thCls } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { formatDate, poLineLabel } from '../../lib/format';
import { ShipmentDrawer } from '../shipments/ShipmentDrawer';
import { daysText } from './common';
import { TrendChart } from './TrendChart';

const AGE_SERIES = AGE_BUCKETS.map((b, i) => ({ key: b.key, label: b.label, color: `var(--age-${i + 1})` }));
const WAREHOUSE_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

function PastDueTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as PastDuePoint;
  return (
    <div className={tooltipBoxCls}>
      <div className="mb-1 font-medium">{formatDate(p.reportDate)} report</div>
      <Row label="Past due, not received" value={`${p.lines.toLocaleString()} lines`} />
      {AGE_SERIES.map((s) => (p[s.key] ? <Row key={s.key} color={s.color} label={s.label} value={p[s.key].toLocaleString()} /> : null))}
      <Row label="Units" value={p.units.toLocaleString()} />
    </div>
  );
}

/** Past-due lines per report, stacked by how long past their ETA, with a table view. */
function PastDueChart({ points }: { points: PastDuePoint[] }) {
  const [table, setTable] = useState(false);
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Legend items={AGE_SERIES} />
        <button onClick={() => setTable(!table)} className="ml-auto text-xs text-slate-500 hover:underline">
          {table ? 'Show chart' : 'Show as table'}
        </button>
      </div>
      {table ? (
        <table className={tableCls}>
          <thead>
            <tr>
              {['Report', 'Lines', ...AGE_SERIES.map((s) => s.label), 'Units'].map((h) => <th key={h} className={`${thCls} text-right first:text-left`}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.reportDate}>
                <td className={tdCls}>{formatDate(p.reportDate)}</td>
                {[p.lines, ...AGE_SERIES.map((s) => p[s.key]), p.units].map((v, i) => <td key={i} className={`${tdCls} text-right tabular-nums`}>{v.toLocaleString()}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="30%">
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="reportDate" tickFormatter={(d: string) => formatDate(d, { year: undefined })} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} axisLine={{ stroke: 'var(--grid)' }} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip content={PastDueTooltip} cursor={{ fill: 'var(--grid)', opacity: 0.5 }} />
              {AGE_SERIES.map((s, i) => (
                <Bar key={s.key} dataKey={s.key} name={s.label} stackId="age" fill={s.color} stroke="var(--surface)" strokeWidth={2} radius={i === AGE_SERIES.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

const LINE_COLUMNS: Column<PastDueLine>[] = [
  { id: 'days', label: 'Past due', align: 'right', sortValue: (l) => l.daysPastDue, render: (l) => <span className="font-medium text-red-700 dark:text-red-300">{l.daysPastDue}d</span> },
  { id: 'eta', label: 'ETA', sortValue: (l) => l.eta, render: (l) => <span className="whitespace-nowrap">{formatDate(l.eta)}</span> },
  { id: 'supplier', label: 'Supplier', sortValue: (l) => l.supplier, render: (l) => l.supplier },
  { id: 'po', label: 'PO / line', sortValue: (l) => `${l.poNumber}|${l.lineRef}`, render: (l) => <span className="whitespace-nowrap">{poLineLabel(l)}</span> },
  { id: 'part', label: 'Part', sortValue: (l) => l.partNumber, render: (l) => l.partNumber ?? '—', className: 'whitespace-nowrap text-xs' },
  { id: 'branch', label: 'Warehouse', sortValue: (l) => l.branch, render: (l) => l.branch ?? '—', className: 'whitespace-nowrap text-xs' },
  { id: 'qty', label: 'Qty', align: 'right', sortValue: (l) => l.quantity, render: (l) => l.quantity?.toLocaleString() ?? '—' },
  { id: 'status', label: 'Status', sortValue: (l) => l.status, render: (l) => <StatusBadge status={l.status} /> },
];

/**
 * Receiving at our warehouses: PO lines past their ETA that no report shows received yet (whether
 * the supplier is late or receipts are backed up), and how long received stock waits to ship.
 */
export function ReceivingTab({ branch }: { branch: string }) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<number | null>(null);
  const { data, error, isLoading } = useQuery({
    queryKey: ['performance-receiving', branch],
    queryFn: () => api<ReceivingResponse>(`/reports/performance/receiving${qs({ branch: branch || undefined })}`),
  });
  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <div className="h-72 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-900" />;
  const latest = data.pastDue[data.pastDue.length - 1];
  const before = data.pastDue[data.pastDue.length - 2];
  const oldest = data.current[0]?.daysPastDue ?? null;
  const warehouses = data.receiptToShip.slice(0, WAREHOUSE_COLORS.length);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Past due, not received" value={data.current.length.toLocaleString()} warn={data.current.length > 0} hint="Lines past their ETA today, still open in the latest report" />
        <StatTile label="Oldest past due" value={daysText(oldest)} warn={(oldest ?? 0) > 30} hint="Days since its ETA" />
        <StatTile
          label="At the latest report"
          value={latest ? latest.lines.toLocaleString() : '—'}
          hint={latest ? `${formatDate(latest.reportDate)}${before ? ` · ${latest.lines - before.lines >= 0 ? '+' : ''}${latest.lines - before.lines} vs ${formatDate(before.reportDate, { year: undefined })}` : ''}` : undefined}
        />
        <StatTile label="Received to shipped" value={daysText(warehouses[0]?.medianDays ?? null)} hint={warehouses[0] ? `median at ${warehouses[0].branch}, last 12 months` : 'Import the Transactions tab'} />
      </div>

      <Card>
        <h2 className="font-medium">Past due, not received, per report</h2>
        <p className="mb-2 text-sm text-slate-500">
          Open PO lines whose ETA had passed when each report was run, by how long. A growing or aging pile points to late suppliers or a receiving backlog.
        </p>
        {data.pastDue.length ? (
          <PastDueChart points={data.pastDue} />
        ) : (
          <Empty>{data.reports ? 'No past-due lines in the kept reports.' : 'Builds up from reports imported from now on: each kept Supplier POs report adds a point.'}</Empty>
        )}
      </Card>

      {data.byBranch.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <h2 className="px-4 pt-4 font-medium">By warehouse, at the latest report</h2>
          <table className={tableCls}>
            <thead>
              <tr>{['Warehouse', 'Lines', ...AGE_SERIES.map((s) => s.label), 'Units'].map((h) => <th key={h} className={`${thCls} text-right first:text-left`}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {data.byBranch.map((b) => (
                <tr key={b.branch} onClick={() => navigate(`/inbound?late=1&branch=${encodeURIComponent(b.branch)}`)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900">
                  <td className={`${tdCls} font-medium`}>{b.branch}</td>
                  {[b.latest?.lines ?? 0, ...AGE_SERIES.map((s) => b.latest?.[s.key] ?? 0), b.latest?.units ?? 0].map((v, i) => (
                    <td key={i} className={`${tdCls} text-right tabular-nums`}>{v.toLocaleString()}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 text-xs text-slate-500">Click a warehouse for its past-due lines on Inbound.</p>
        </Card>
      )}

      <Card className="p-0">
        <div className="px-4 pt-4">
          <h2 className="font-medium">Past-due lines now</h2>
          <p className="text-sm text-slate-500">Oldest first. Click a line for its history.</p>
        </div>
        <DataTable id="receiving-past-due" rows={data.current} columns={LINE_COLUMNS} rowKey={(l) => l.id} onRowClick={(l) => setSelected(l.id)} empty="Nothing past due." />
      </Card>

      <Card>
        <h2 className="font-medium">Days from receipt to shipping</h2>
        <p className="mb-2 text-sm text-slate-500">Median days between receiving stock and shipping it to the customer, per warehouse and ship month (Transactions tab).</p>
        {warehouses.length ? (
          <>
            <TrendChart
              unit="shipments"
              percent={false}
              format={(v) => `${Math.round(v)}d`}
              series={warehouses.map((w, i) => ({ key: `w${i}`, label: w.branch, color: WAREHOUSE_COLORS[i], points: w.months.map((m) => ({ month: m.month, count: m.count, onTimePct: m.medianDays })) }))}
            />
            {data.receiptToShip.length > warehouses.length && (
              <p className="mt-2 text-xs text-slate-500">
                Also: {data.receiptToShip.slice(warehouses.length).map((w) => `${w.branch} ${daysText(w.medianDays)} (${w.shipments})`).join(' · ')}
              </p>
            )}
          </>
        ) : (
          <Empty>Import a report with the Transactions tab.</Empty>
        )}
      </Card>
      {selected !== null && <ShipmentDrawer id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
