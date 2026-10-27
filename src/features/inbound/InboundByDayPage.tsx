import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addDays, todayIso } from '../../../shared/dates';
import { estimatedShare, mergeSummaries, type PalletSummary } from '../../../shared/pallets';
import type { InboundDay, InboundResponse } from '../../../shared/types';
import { BasisBadge, Card, DateInput, Empty, ErrorNote, PageHeader, StatTile, StatusBadge, tableCls, tdCls, thCls } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { formatDate, formatPallets, poLineLabel } from '../../lib/format';
import { useBranch } from '../../app/branch';
import { DataQualityNote, MetricToggle, useStoredChoice } from '../../components/pallets';
import { ShipmentDrawer } from '../shipments/ShipmentDrawer';
import { BranchSummaryTable } from './BranchSummaryTable';
import { InboundByPartTable } from './InboundByPartTable';
import { InboundChart, METRICS, type Metric } from './InboundChart';

const METRIC_LABELS: Record<Metric, string> = { pallets: 'Pallets', units: 'Units', lines: 'Lines' };
function rangeSum(days: InboundDay[], from: string, to: string): PalletSummary {
  return mergeSummaries(days.filter((d) => d.date >= from && d.date <= to).map((d) => d.pallets));
}

export function InboundByDayPage() {
  const [from, setFrom] = useState(addDays(todayIso(), -7));
  const [to, setTo] = useState(addDays(todayIso(), 21));
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [metric, setMetric] = useStoredChoice<Metric>('inbound-metric', METRICS, 'pallets');
  const { branch } = useBranch();

  const { data, error, isLoading } = useQuery({
    queryKey: ['inbound-by-day', from, to, branch],
    queryFn: () => api<InboundResponse>(`/reports/inbound-by-day${qs({ from, to, branch: branch || undefined })}`),
  });
  const days = data?.days ?? [];
  const parts = data?.parts ?? [];
  const today = todayIso();
  const total = days.reduce((n, d) => n + d.total, 0);
  const todayCount = days.find((d) => d.date === today)?.total ?? 0;
  const nextWeek = days.filter((d) => d.date > today && d.date <= addDays(today, 7)).reduce((n, d) => n + d.total, 0);
  const overdue = days
    .filter((d) => d.date < today)
    .reduce((n, d) => n + d.shipments.filter((s) => !s.actualArrivalDate).length, 0);
  const inRange = mergeSummaries(days.map((d) => d.pallets));
  const todaySum = rangeSum(days, today, today);
  const weekSum = rangeSum(days, addDays(today, 1), addDays(today, 7));
  const estPct = Math.round(estimatedShare(inRange) * 100);

  function selectDay(date: string) {
    setOpenDay(date);
    document.getElementById(`day-${date}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={branch ? `Inbound by day · ${branch}` : 'Inbound by day'}
        description="PO lines grouped by expected arrival (carrier ETA when known, otherwise the supplier's ETA). Lines awaiting shipment have no date yet and are listed on the Shipments page."
        actions={
          <>
            <MetricToggle options={METRICS} labels={METRIC_LABELS} value={metric} onChange={setMetric} />
            <DateInput label="From" value={from} onChange={setFrom} />
            <DateInput label="To" value={to} onChange={setTo} />
          </>
        }
      />
      {error && <ErrorNote error={error} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {metric === 'lines' && (
          <>
            <StatTile label="Expected today" value={todayCount} />
            <StatTile label="Next 7 days" value={nextWeek} />
            <StatTile label="Past due, not arrived" value={overdue} hint="Expected date passed in this range" />
            <StatTile label="In range" value={total} />
          </>
        )}
        {metric === 'units' && (
          <>
            <StatTile label="Units today" value={todaySum.units.toLocaleString()} />
            <StatTile label="Units next 7 days" value={weekSum.units.toLocaleString()} />
            <StatTile label="Units in range" value={inRange.units.toLocaleString()} />
            <StatTile label="Units with no pallet ratio" value={inRange.noRatioUnits.toLocaleString()} warn={inRange.noRatioUnits > 0} />
          </>
        )}
        {metric === 'pallets' && (
          <>
            <StatTile label="Pallets today" value={formatPallets(todaySum.palletEq)} hint={`${todaySum.fullPallets} full + ${todaySum.partialPallets} partial`} />
            <StatTile label="Pallets next 7 days" value={formatPallets(weekSum.palletEq)} hint={`${weekSum.fullPallets} full + ${weekSum.partialPallets} partial`} />
            <StatTile
              label="Pallets in range"
              value={formatPallets(inRange.palletEq)}
              hint={`${inRange.fullPallets} full + ${inRange.partialPallets} partial (may be combined)`}
            />
            <StatTile
              label="Estimated"
              value={`${estPct}%`}
              warn={inRange.estimatedLines > 0 || inRange.noRatioLines > 0}
              hint={inRange.noRatioLines ? `${inRange.noRatioLines} lines with no ratio, not counted` : 'of pallets in range'}
            />
          </>
        )}
      </div>

      {metric !== 'lines' && <DataQualityNote sum={inRange} parts={parts} />}

      {!branch && <BranchSummaryTable />}

      <Card>
        {isLoading ? (
          <div className="h-72 animate-pulse rounded-md bg-slate-100 dark:bg-slate-900" />
        ) : days.length === 0 ? (
          <Empty>No inbound shipments in this range. Import a report to get started.</Empty>
        ) : (
          <InboundChart days={days} metric={metric} onSelectDay={selectDay} />
        )}
      </Card>

      <InboundByPartTable parts={parts} />

      <div className="space-y-3">
        {days.map((d) => {
          const open = openDay === d.date;
          return (
            <Card key={d.date} className="scroll-mt-4 p-0">
              <button
                id={`day-${d.date}`}
                onClick={() => setOpenDay(open ? null : d.date)}
                className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left"
                aria-expanded={open}
              >
                <span className={`font-medium ${d.date === today ? 'text-blue-700 dark:text-blue-300' : ''}`}>
                  {formatDate(d.date, { weekday: 'short' })}
                  {d.date === today && ' · Today'}
                </span>
                <span className="text-sm tabular-nums text-slate-500">{d.total} lines</span>
                <span className="text-sm tabular-nums text-slate-500">
                  {formatPallets(d.pallets.palletEq)} pallets
                  {d.pallets.estimatedLines > 0 && <span className="text-amber-700 dark:text-amber-300"> (incl. {formatPallets(d.pallets.estimatedPalletEq)} est.)</span>}
                  {d.pallets.noRatioLines > 0 && <span className="text-red-700 dark:text-red-300"> · {d.pallets.noRatioUnits.toLocaleString()} units no ratio</span>}
                </span>
                <span className="text-sm text-slate-500">
                  {Object.entries(d.byCarrier)
                    .sort((a, b) => b[1] - a[1])
                    .map(([c, n]) => `${c} ${n}`)
                    .join(' · ')}
                </span>
                <span className="ml-auto text-sm text-slate-400">{open ? 'Hide' : 'Show'}</span>
              </button>
              {open && (
                <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
                  <table className={tableCls}>
                    <thead>
                      <tr>{['Supplier', 'PO / line', 'ASN', 'Part', 'Qty', 'Pallets', 'Carrier', 'Tracking', 'Status'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {d.shipments.map((s) => (
                        <tr key={s.id} onClick={() => setSelected(s.id)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900">
                          <td className={tdCls}>{s.supplier}</td>
                          <td className={`${tdCls} whitespace-nowrap`}>{poLineLabel(s)}</td>
                          <td className={`${tdCls} font-mono text-xs`}>{s.asn ?? '—'}</td>
                          <td className={`${tdCls} text-xs`}>{s.partNumber ?? '—'}</td>
                          <td className={`${tdCls} tabular-nums`}>{s.quantity?.toLocaleString() ?? '—'}</td>
                          <td className={`${tdCls} whitespace-nowrap tabular-nums`}>
                            {s.pallets.palletEq != null && <span className="mr-2">{formatPallets(s.pallets.palletEq)}</span>}
                            {s.pallets.basis !== 'real' && <BasisBadge basis={s.pallets.basis} estimate={s.pallets.estimate} short />}
                          </td>
                          <td className={tdCls}>{s.carrier ?? '—'}</td>
                          <td className={`${tdCls} font-mono text-xs`}>{s.trackingNumber ?? '—'}</td>
                          <td className={tdCls}><StatusBadge status={s.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          );
        })}
      </div>
      {selected !== null && <ShipmentDrawer id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
