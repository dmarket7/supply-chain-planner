import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SupplierRating } from '../../../shared/performance';
import type { SupplierPerformanceResponse } from '../../../shared/types';
import { DataTable, type Column } from '../../components/DataTable';
import { ChipGroup, useUrlFilters } from '../../components/filters';
import { Card, Empty, ErrorNote, StatTile } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { daysText, onTimeHint, pctText, SupplierStatusBadge } from './common';
import { SupplierDrawer } from './SupplierDrawer';
import { Sparkline, TrendChart } from './TrendChart';

const COLUMNS: Column<SupplierRating>[] = [
  { id: 'supplier', label: 'Supplier', sortValue: (s) => s.supplier, render: (s) => <span className="block max-w-64 truncate font-medium" title={s.supplier}>{s.supplier}</span> },
  { id: 'status', label: 'Status', sortValue: (s) => (s.status === 'consistently_late' ? 0 : s.status === 'getting_worse' ? 1 : s.status === 'reliable' ? 3 : 2), render: (s) => <SupplierStatusBadge status={s.status} /> },
  { id: 'arrivals', label: 'Received', title: 'Lines received in the period with a promise we recorded first', align: 'right', sortValue: (s) => s.arrival.count, render: (s) => s.arrival.count.toLocaleString() },
  {
    id: 'arrivalPct',
    label: 'On time',
    title: 'Received on or before the first ETA we recorded',
    align: 'right',
    sortValue: (s) => s.arrival.onTimePct,
    render: (s) => <span className={s.arrival.onTimePct !== null && s.arrival.onTimePct < 50 ? 'font-medium text-red-700 dark:text-red-300' : ''}>{pctText(s.arrival.onTimePct)}</span>,
  },
  { id: 'medianLate', label: 'Median late', title: 'Of late lines, days after the first ETA', align: 'right', sortValue: (s) => s.arrival.medianDaysLate, render: (s) => daysText(s.arrival.medianDaysLate) },
  { id: 'months', label: 'Last 6 months', render: (s) => <Sparkline points={s.months} /> },
  { id: 'shipPct', label: 'Shipped on time', title: 'Shipped on or before the first ETD we recorded', align: 'right', sortValue: (s) => s.ship.onTimePct, render: (s) => (s.ship.count ? `${pctText(s.ship.onTimePct)} of ${s.ship.count}` : '—') },
  { id: 'moves', label: 'ETA moves / line', align: 'right', sortValue: (s) => s.etaMovesPerLine, render: (s) => s.etaMovesPerLine?.toFixed(2) ?? '—' },
  { id: 'afterRequest', label: 'ETD after request', title: "Lines whose first ETD was after Meta's requested ship date (CRD)", align: 'right', sortValue: (s) => s.etdAfterRequestPct, render: (s) => pctText(s.etdAfterRequestPct) },
  { id: 'open', label: 'Open lines', align: 'right', sortValue: (s) => s.openLines, render: (s) => s.openLines.toLocaleString(), defaultHidden: true },
  { id: 'lines', label: 'Active lines', align: 'right', sortValue: (s) => s.lines, render: (s) => s.lines.toLocaleString(), defaultHidden: true },
];

export function SuppliersTab({ branch, period }: { branch: string; period: string }) {
  const f = useUrlFilters();
  const includeHistory = f.get('history') === '1';
  const [measure, setMeasure] = useState<'arrival' | 'ship'>('arrival');
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, isLoading } = useQuery({
    queryKey: ['performance-suppliers', branch, period, includeHistory],
    queryFn: () => api<SupplierPerformanceResponse>(`/reports/performance/suppliers${qs({ branch: branch || undefined, period, includeHistory: includeHistory ? '1' : undefined })}`),
  });
  if (error) return <ErrorNote error={error} />;
  if (isLoading || !data) return <div className="h-72 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-900" />;
  if (!data.firstUpload) return <Empty>Import a report with the Supplier POs tab to start measuring suppliers.</Empty>;
  const t = data.totals;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-500">
        <span>
          Promises are known from the {formatDate(data.firstUpload)} upload on: a line counts once we recorded its ETA before it arrived. Late = any day after that
          first ETA.
        </span>
        <label className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={includeHistory} onChange={(e) => f.set('history', e.target.checked ? '1' : null)} />
          Include lines received before the first upload (vs final ETA)
        </label>
      </div>
      {includeHistory ? (
        <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Lines received before {formatDate(data.firstUpload)} are measured against their final ETA. Suppliers often move the ETA to the receipt date, so these
          understate lateness.
        </p>
      ) : (
        t.historyArrivals > 0 && (
          <p className="text-sm text-slate-500">
            {t.historyArrivals.toLocaleString()} more lines were received in this period before their promise was recorded; each weekly upload adds to the
            measured lines.
          </p>
        )
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Received on time" value={pctText(t.arrival.onTimePct)} warn={(t.arrival.onTimePct ?? 100) < 80} hint={onTimeHint(t.arrival, t.previousArrival)} />
        <StatTile label="Median days late" value={daysText(t.arrival.medianDaysLate)} hint={`of ${(t.arrival.count - t.arrival.onTime).toLocaleString()} late lines, after the first ETA`} />
        <StatTile label="Shipped on time" value={pctText(t.ship.onTimePct)} hint={`${t.ship.count.toLocaleString()} lines, vs the first ETD`} />
        <StatTile
          label="Consistently late suppliers"
          value={t.consistentlyLate.toLocaleString()}
          warn={t.consistentlyLate > 0}
          hint={`${t.gettingWorse.toLocaleString()} getting worse · ${t.suppliers.toLocaleString()} suppliers active`}
        />
      </div>

      <Card>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">On time by month</h2>
          <ChipGroup
            label="Measure"
            value={measure}
            options={[
              { value: 'arrival', label: 'Arrival vs first ETA' },
              { value: 'ship', label: 'Shipping vs first ETD' },
            ]}
            onChange={(v) => setMeasure(v === 'ship' ? 'ship' : 'arrival')}
          />
        </div>
        <TrendChart series={[{ key: measure, label: measure === 'arrival' ? 'Received on time' : 'Shipped on time', color: 'var(--series-1)', points: data.trend[measure] }]} />
      </Card>

      <Card className="p-0">
        <div className="px-4 pt-4">
          <h2 className="font-medium">Supplier scorecard</h2>
          <p className="text-sm text-slate-500">Worst first. Click a supplier for its monthly trend and late lines.</p>
        </div>
        <DataTable id="supplier-scorecard" rows={data.suppliers} columns={COLUMNS} rowKey={(s) => s.supplier} onRowClick={(s) => setOpen(s.supplier)} empty="No supplier activity in this period." />
      </Card>
      {open && <SupplierDrawer supplier={open} branch={branch} includeHistory={includeHistory} onClose={() => setOpen(null)} />}
    </div>
  );
}
