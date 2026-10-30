import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { SHIP_BASELINE_LABELS, SHIP_BASELINES, type ShipBaseline, type ShipGroup, type ShippedLine } from '../../../shared/performance';
import type { ShippingPerformanceResponse } from '../../../shared/types';
import { DataTable, type Column } from '../../components/DataTable';
import { ChipGroup } from '../../components/filters';
import { Card, Empty, ErrorNote, StatTile } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { DaysLate, daysText, onTimeHint, pctText } from './common';
import { TrendChart } from './TrendChart';

const COLORS: Record<ShipBaseline, string> = { vsConfirmed: 'var(--series-1)', vsRequest: 'var(--series-2)', vsEtd: 'var(--series-3)' };
const SHORT: Record<ShipBaseline, string> = { vsConfirmed: 'vs confirmed', vsRequest: 'vs request', vsEtd: 'vs SO ETD' };

const cell = (g: ShipGroup, b: ShipBaseline) => (g[b].count ? `${pctText(g[b].onTimePct)} of ${g[b].count.toLocaleString()}` : '—');

function groupColumns(label: string): Column<ShipGroup>[] {
  return [
    { id: 'name', label, sortValue: (g) => g.name, render: (g) => <span className="block max-w-72 truncate font-medium" title={g.name}>{g.name}</span> },
    { id: 'shipments', label: 'Shipments', align: 'right', sortValue: (g) => g.shipments, render: (g) => g.shipments.toLocaleString() },
    { id: 'units', label: 'Units', align: 'right', sortValue: (g) => g.units, render: (g) => g.units.toLocaleString(), defaultHidden: true },
    ...SHIP_BASELINES.map((b): Column<ShipGroup> => ({
      id: b,
      label: `On time ${SHORT[b]}`,
      title: `Shipped on or before the ${SHIP_BASELINE_LABELS[b].toLowerCase()}`,
      align: 'right',
      sortValue: (g) => g[b].onTimePct,
      render: (g) => <span className={(g[b].onTimePct ?? 100) < 50 ? 'font-medium text-red-700 dark:text-red-300' : ''}>{cell(g, b)}</span>,
    })),
    { id: 'medianLate', label: 'Median late vs SO ETD', align: 'right', sortValue: (g) => g.vsEtd.medianDaysLate, render: (g) => daysText(g.vsEtd.medianDaysLate) },
  ];
}

const d = (iso: string | null) => <span className="whitespace-nowrap">{formatDate(iso, { year: undefined })}</span>;
const LATE_COLUMNS: Column<ShippedLine>[] = [
  { id: 'shipDate', label: 'Shipped', sortValue: (l) => l.shipDate, render: (l) => d(l.shipDate) },
  { id: 'shipTo', label: 'Ship to', sortValue: (l) => l.shipTo, render: (l) => <span className="block max-w-56 truncate" title={l.shipTo ?? undefined}>{l.shipTo ?? '—'}</span> },
  { id: 'po', label: 'EMS PO#', sortValue: (l) => l.odmPo, render: (l) => l.odmPo ?? '—', className: 'font-mono text-xs' },
  { id: 'part', label: 'Part', sortValue: (l) => l.partNumber, render: (l) => l.partNumber ?? '—', className: 'whitespace-nowrap text-xs' },
  { id: 'qty', label: 'Qty', align: 'right', sortValue: (l) => l.quantity, render: (l) => l.quantity?.toLocaleString() ?? '—' },
  { id: 'confirmed', label: 'First confirmed', sortValue: (l) => l.firstConfirmed, render: (l) => d(l.firstConfirmed) },
  { id: 'vsConfirmed', label: 'vs confirmed', sortValue: (l) => l.vsConfirmed, render: (l) => <DaysLate days={l.vsConfirmed} /> },
  { id: 'request', label: 'Requested dock', sortValue: (l) => l.firstRequest, render: (l) => d(l.firstRequest) },
  { id: 'vsRequest', label: 'vs request', sortValue: (l) => l.vsRequest, render: (l) => <DaysLate days={l.vsRequest} /> },
  { id: 'etd', label: 'SO ETD', sortValue: (l) => l.soEtd, render: (l) => d(l.soEtd) },
  { id: 'vsEtd', label: 'vs SO ETD', sortValue: (l) => l.vsEtd, render: (l) => <DaysLate days={l.vsEtd} /> },
  { id: 'moves', label: 'Confirmed date moves', align: 'right', sortValue: (l) => l.confirmedMoves, render: (l) => l.confirmedMoves || '—', defaultHidden: true },
  { id: 'branch', label: 'Warehouse', sortValue: (l) => l.branch, render: (l) => l.branch ?? '—', className: 'whitespace-nowrap text-xs', defaultHidden: true },
];

/** Wintec's shipments against the confirmed ship date, the customer's requested dock date and SO ETD. */
export function ShippingTab({ branch, period }: { branch: string; period: string }) {
  const navigate = useNavigate();
  const [groupBy, setGroupBy] = useState<'shipTo' | 'branch'>('shipTo');
  const { data, error, isLoading } = useQuery({
    queryKey: ['performance-shipping', branch, period],
    queryFn: () => api<ShippingPerformanceResponse>(`/reports/performance/shipping${qs({ branch: branch || undefined, period })}`),
  });
  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <div className="h-72 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-900" />;
  if (!data.trend.some((m) => m.vsEtd.count)) return <Empty>Import a report with the Transactions tab to measure shipping.</Empty>;
  const t = data.totals;

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500">
        {data.shipments.toLocaleString()} shipments in this period. Confirmed and requested dates come from the ODM Open Order report that listed the order
        before it shipped ({data.matched.toLocaleString()} matched{data.firstOrderReport ? `, from the ${formatDate(data.firstOrderReport)} report on` : ''}); SO ETD
        comes with every shipment. Late = any day after the date.
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="On time vs Wintec confirmed" value={pctText(t.vsConfirmed.onTimePct)} warn={(t.vsConfirmed.onTimePct ?? 100) < 80} hint={onTimeHint(t.vsConfirmed, data.previous.vsConfirmed, 'shipments')} />
        <StatTile label="On time vs customer request" value={pctText(t.vsRequest.onTimePct)} warn={(t.vsRequest.onTimePct ?? 100) < 80} hint={onTimeHint(t.vsRequest, data.previous.vsRequest, 'shipments')} />
        <StatTile label="On time vs SO ETD" value={pctText(t.vsEtd.onTimePct)} warn={(t.vsEtd.onTimePct ?? 100) < 80} hint={onTimeHint(t.vsEtd, data.previous.vsEtd, 'shipments')} />
        <StatTile label="Median days late vs confirmed" value={daysText(t.vsConfirmed.medianDaysLate)} hint={`vs SO ETD: ${daysText(t.vsEtd.medianDaysLate)}`} />
      </div>

      <Card>
        <h2 className="mb-2 font-medium">Shipped on time by month</h2>
        <TrendChart unit="shipments" series={SHIP_BASELINES.map((b) => ({ key: b, label: SHIP_BASELINE_LABELS[b], color: COLORS[b], points: data.trend.map((m) => m[b]) }))} />
      </Card>

      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
          <h2 className="font-medium">Where we ship late</h2>
          <ChipGroup label="Group by" value={groupBy} options={[{ value: 'shipTo', label: 'By ship-to' }, { value: 'branch', label: 'By warehouse' }]} onChange={(v) => setGroupBy(v === 'branch' ? 'branch' : 'shipTo')} />
        </div>
        <DataTable
          id={`shipping-by-${groupBy}`}
          rows={groupBy === 'shipTo' ? data.byShipTo : data.byBranch}
          columns={groupColumns(groupBy === 'shipTo' ? 'Ship to' : 'Warehouse')}
          rowKey={(g) => g.name}
          onRowClick={groupBy === 'shipTo' ? (g) => navigate(`/outbound?shipTo=${encodeURIComponent(g.name)}`) : undefined}
          empty="No shipments in this period."
        />
        {groupBy === 'shipTo' && <p className="px-4 pb-3 text-xs text-slate-500">Click a ship-to for its open orders on Outbound.</p>}
      </Card>

      <Card className="p-0">
        <div className="px-4 pt-4">
          <h2 className="font-medium">Late shipments</h2>
          <p className="text-sm text-slate-500">Shipped after the first confirmed date, or after SO ETD when the order wasn't in an earlier report. Latest first.</p>
        </div>
        <DataTable id="shipping-late" rows={data.late} columns={LATE_COLUMNS} rowKey={(l) => l.id} empty="No late shipments in this period." />
      </Card>
    </div>
  );
}
