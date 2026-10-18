import { useDeferredValue, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SHIPMENT_STATUSES, type Shipment, type ShipmentStatus } from '../../../shared/types';
import { Card, Empty, ErrorNote, PageHeader, StatusBadge, tableCls, tdCls, thCls } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { STATUS_LABELS, arrivalLabel, formatDate, poLineLabel } from '../../lib/format';
import { useBranch } from '../../app/branch';
import { ShipmentDrawer } from './ShipmentDrawer';
import { useTrackingRefresh } from './TrackingRefresh';

export function ShipmentsPage() {
  const [status, setStatus] = useState<ShipmentStatus | 'all'>('all');
  const [carrier, setCarrier] = useState('');
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [selected, setSelected] = useState<number | null>(null);
  const { branch } = useBranch();

  // Status counts come from the unfiltered-by-status list so the tabs stay stable.
  const { data, error, isLoading } = useQuery({
    queryKey: ['shipments', carrier, q, branch],
    queryFn: () =>
      api<Shipment[]>(`/shipments${qs({ carrier: carrier || undefined, q: q || undefined, branch: branch || undefined })}`),
  });
  const all = data ?? [];
  const counts = useMemo(() => {
    const c: Partial<Record<ShipmentStatus, number>> = {};
    for (const s of all) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [all]);
  const carriers = useMemo(() => [...new Set(all.map((s) => s.carrier).filter(Boolean) as string[])].sort(), [all]);
  const rows = status === 'all' ? all : all.filter((s) => s.status === status);

  const tracking = useTrackingRefresh();

  const tab = (key: ShipmentStatus | 'all', label: string, n: number) => (
    <button
      key={key}
      onClick={() => setStatus(key)}
      className={`rounded-md px-3 py-1.5 text-sm ${status === key ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'bg-white text-slate-600 hover:bg-slate-100 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-800'}`}
    >
      {label} <span className="tabular-nums opacity-70">{n}</span>
    </button>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={branch ? `Shipments · ${branch}` : 'Shipments'}
        description="All shipments by tracking status."
        actions={
          <>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tracking, PO, ASN, part, supplier"
              className="w-64 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
            <select
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="">All carriers</option>
              {carriers.map((c) => <option key={c}>{c}</option>)}
            </select>
            {tracking.buttons}
          </>
        }
      />
      {tracking.status}
      {error && <ErrorNote error={error} />}

      <div className="flex flex-wrap gap-2">
        {tab('all', 'All', all.length)}
        {SHIPMENT_STATUSES.filter((s) => counts[s]).map((s) => tab(s, STATUS_LABELS[s], counts[s]!))}
      </div>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <div className="p-6 text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-4"><Empty>No shipments match.</Empty></div>
        ) : (
          <table className={tableCls}>
            <thead>
              <tr>{[...(branch ? [] : ['Branch']), 'Status', 'Supplier', 'PO / line', 'ASN', 'Part', 'Carrier', 'Tracking', 'ETA', 'Arrived'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} onClick={() => setSelected(s.id)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900">
                  {!branch && <td className={`${tdCls} whitespace-nowrap text-xs`}>{s.branch ?? '—'}</td>}
                  <td className={tdCls}><StatusBadge status={s.status} /></td>
                  <td className={tdCls}>{s.supplier}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>{poLineLabel(s)}</td>
                  <td className={`${tdCls} font-mono text-xs`}>{s.asn ?? '—'}</td>
                  <td className={`${tdCls} text-xs`}>{s.partNumber ?? '—'}</td>
                  <td className={tdCls}>{s.carrier ?? '—'}</td>
                  <td className={`${tdCls} font-mono text-xs`}>{s.trackingNumber ?? '—'}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>{formatDate(s.estimatedArrivalDate ?? s.promisedArrivalDate)}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>
                    {arrivalLabel(s)}
                    {s.arrivalSource === 'report_window' || s.arrivalSource === 'eta' ? <span className="ml-1 text-xs text-slate-500">est.</span> : null}
                  </td>
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
