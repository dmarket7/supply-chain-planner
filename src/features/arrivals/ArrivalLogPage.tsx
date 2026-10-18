import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addDays, todayIso } from '../../../shared/dates';
import type { ArrivalsResponse } from '../../../shared/types';
import { Card, DateInput, Empty, ErrorNote, PageHeader, StatTile, tableCls, tdCls, thCls } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { ARRIVAL_SOURCE_LABELS, arrivalLabel, formatDate, poLineLabel, varianceLabel } from '../../lib/format';
import { useBranch } from '../../app/branch';
import { ShipmentDrawer } from '../shipments/ShipmentDrawer';

function VarianceCell({ days }: { days: number }) {
  const cls = days > 0 ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300';
  return (
    <span className={`tabular-nums ${cls}`}>
      {days > 0 ? '▲ ' : days < 0 ? '▼ ' : '● '}
      {varianceLabel(days)}
    </span>
  );
}

export function ArrivalLogPage() {
  const [from, setFrom] = useState(addDays(todayIso(), -90));
  const [to, setTo] = useState(todayIso());
  const [supplier, setSupplier] = useState('');
  const [includeAssumed, setIncludeAssumed] = useState(false);
  const { branch } = useBranch();
  const [selected, setSelected] = useState<number | null>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: ['arrivals', from, to, supplier, includeAssumed, branch],
    queryFn: () =>
      api<ArrivalsResponse>(
        `/reports/arrivals${qs({ from, to, supplier: supplier || undefined, branch: branch || undefined, includeAssumed: includeAssumed ? '1' : undefined })}`,
      ),
  });
  const allEntries = data?.entries ?? [];
  const assumedCount = allEntries.filter((e) => e.arrivalSource === 'eta').length;
  // Headline stats follow the same rule as the scorecard.
  const entries = includeAssumed ? allEntries : allEntries.filter((e) => e.arrivalSource !== 'eta');
  const onTime = entries.filter((e) => e.onTime).length;
  const late = entries.filter((e) => !e.onTime);
  const avgLate = late.length ? late.reduce((n, e) => n + e.varianceDays, 0) / late.length : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={branch ? `Arrival log · ${branch}` : 'Arrival log'}
        description="Arrival compared with the first ETA the supplier gave. Arrivals marked est. are inferred from when the line closed between two reports."
        actions={
          <>
            <DateInput label="Arrived from" value={from} onChange={setFrom} />
            <DateInput label="To" value={to} onChange={setTo} />
            <label
              className="flex items-center gap-2 pb-1.5 text-sm"
              title="Lines already closed the first time they were imported have their arrival assumed to be the supplier ETA, so they always look on time."
            >
              <input type="checkbox" checked={includeAssumed} onChange={(e) => setIncludeAssumed(e.target.checked)} />
              Include ETA-assumed arrivals{assumedCount > 0 && ` (${assumedCount})`}
            </label>
            {supplier && (
              <button onClick={() => setSupplier('')} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
                {supplier} ✕
              </button>
            )}
          </>
        }
      />
      {error && <ErrorNote error={error} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Arrivals" value={entries.length} />
        <StatTile label="On-time rate" value={entries.length ? `${Math.round((onTime / entries.length) * 100)}%` : '—'} hint="Arrived on or before the promised date" />
        <StatTile label="Late arrivals" value={late.length} />
        <StatTile label="Average days late" value={late.length ? avgLate.toFixed(1) : '—'} hint="Among late arrivals" />
      </div>

      {!supplier && (data?.scorecard.length ?? 0) > 0 && (
        <Card className="overflow-x-auto p-0">
          <h2 className="px-4 pt-4 font-medium">Supplier scorecard</h2>
          <table className={tableCls}>
            <thead>
              <tr>{['Supplier', 'Arrivals', 'On time', 'On-time %', 'Avg variance'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {data!.scorecard.map((s) => (
                <tr key={s.supplier} onClick={() => setSupplier(s.supplier)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900">
                  <td className={tdCls}>{s.supplier}</td>
                  <td className={`${tdCls} tabular-nums`}>{s.arrivals}</td>
                  <td className={`${tdCls} tabular-nums`}>{s.onTime}</td>
                  <td className={tdCls}>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div className="h-full rounded-full" style={{ width: `${s.onTimePct}%`, background: 'var(--series-1)' }} />
                      </div>
                      <span className="tabular-nums">{s.onTimePct}%</span>
                    </div>
                  </td>
                  <td className={tdCls}>
                    <VarianceCell days={s.avgVarianceDays} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card className="overflow-x-auto p-0">
        <h2 className="px-4 pt-4 font-medium">Arrivals{supplier && ` · ${supplier}`}</h2>
        {isLoading ? (
          <div className="p-6 text-sm text-slate-500">Loading…</div>
        ) : allEntries.length === 0 ? (
          <div className="p-4"><Empty>No arrivals recorded in this range. Mark shipments as arrived from the Shipments or Inbound pages.</Empty></div>
        ) : (
          <table className={tableCls}>
            <thead>
              <tr>{['Arrived', 'Supplier', 'PO / line', 'ASN', 'Carrier', 'Tracking', 'Supplier ETA', 'Variance', 'Basis'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {[...allEntries].reverse().map((e) => (
                <tr
                  key={e.id}
                  onClick={() => setSelected(e.id)}
                  className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900 ${!includeAssumed && e.arrivalSource === 'eta' ? 'text-slate-400' : ''}`}
                >
                  <td className={`${tdCls} whitespace-nowrap`}>{arrivalLabel(e)}</td>
                  <td className={tdCls}>{e.supplier}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>{poLineLabel(e)}</td>
                  <td className={`${tdCls} font-mono text-xs`}>{e.asn ?? '—'}</td>
                  <td className={tdCls}>{e.carrier ?? '—'}</td>
                  <td className={`${tdCls} font-mono text-xs`}>{e.trackingNumber ?? '—'}</td>
                  <td className={tdCls}>
                    {formatDate(e.originalPromisedDate)}
                    {e.originalPromisedDate !== e.promisedArrivalDate && (
                      <div className="text-xs text-slate-500">later moved to {formatDate(e.promisedArrivalDate)}</div>
                    )}
                  </td>
                  <td className={tdCls}><VarianceCell days={e.varianceDays} /></td>
                  <td className={`${tdCls} whitespace-nowrap text-slate-500`}>{e.arrivalSource ? ARRIVAL_SOURCE_LABELS[e.arrivalSource] : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {selected !== null && <ShipmentDrawer id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
