import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { SupplierLine } from '../../../shared/performance';
import type { SupplierDetailResponse } from '../../../shared/types';
import { DataTable, type Column } from '../../components/DataTable';
import { ErrorNote } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { formatDate, poLineLabel } from '../../lib/format';
import { DaysLate } from './common';
import { TrendChart } from './TrendChart';

const d = (iso: string | null) => <span className="whitespace-nowrap">{formatDate(iso, { year: undefined })}</span>;

const COLUMNS: Column<SupplierLine>[] = [
  { id: 'po', label: 'PO / line', sortValue: (l) => `${l.poNumber}|${l.lineRef}`, render: (l) => <span className="whitespace-nowrap">{poLineLabel(l)}</span> },
  { id: 'part', label: 'Part', sortValue: (l) => l.partNumber, render: (l) => l.partNumber ?? '—', className: 'text-xs' },
  { id: 'firstEta', label: 'First ETA', title: 'The first ETA we recorded, and the upload it came from', sortValue: (l) => l.firstEta, render: (l) => d(l.firstEta) },
  { id: 'finalEta', label: 'Final ETA', sortValue: (l) => l.finalEta, render: (l) => d(l.finalEta) },
  { id: 'arrived', label: 'Received', sortValue: (l) => l.arrived, render: (l) => d(l.arrived) },
  { id: 'arrivalLate', label: 'Arrival', sortValue: (l) => l.arrivalDaysLate, render: (l) => <DaysLate days={l.arrivalDaysLate} /> },
  { id: 'moves', label: 'ETA moves', align: 'right', sortValue: (l) => l.etaMoves, render: (l) => (l.etaMoves ? `${l.etaMoves} · +${l.etaDaysPushed}d` : '—') },
  { id: 'firstEtd', label: 'First ETD', sortValue: (l) => l.firstEtd, render: (l) => d(l.firstEtd), defaultHidden: true },
  { id: 'shipped', label: 'Shipped', sortValue: (l) => l.shipped, render: (l) => d(l.shipped), defaultHidden: true },
  { id: 'shipLate', label: 'Shipping', sortValue: (l) => l.shipDaysLate, render: (l) => <DaysLate days={l.shipDaysLate} /> },
  { id: 'crd', label: 'Requested ship (CRD)', sortValue: (l) => l.requestDate, render: (l) => d(l.requestDate), defaultHidden: true },
  { id: 'branch', label: 'Branch', sortValue: (l) => l.branch, render: (l) => l.branch ?? '—', className: 'whitespace-nowrap text-xs', defaultHidden: true },
  { id: 'qty', label: 'Qty', align: 'right', sortValue: (l) => l.quantity, render: (l) => l.quantity?.toLocaleString() ?? '—', defaultHidden: true },
];

/** One supplier: monthly on-time arrival and shipping, and its lines, latest misses first. */
export function SupplierDrawer({ supplier, branch, includeHistory, onClose }: { supplier: string; branch: string; includeHistory: boolean; onClose: () => void }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['performance-supplier', supplier, branch, includeHistory],
    queryFn: () => api<SupplierDetailResponse>(`/reports/performance/suppliers/${encodeURIComponent(supplier)}${qs({ branch: branch || undefined, includeHistory: includeHistory ? '1' : undefined })}`),
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside className="h-full w-full max-w-4xl overflow-y-auto bg-white p-5 shadow-xl dark:bg-slate-950" onClick={(e) => e.stopPropagation()} aria-label={`${supplier} performance`}>
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">{supplier}</h2>
            <Link to={`/inbound?supplier=${encodeURIComponent(supplier)}&dates=all`} className="text-sm text-slate-500 hover:underline">
              Open its PO lines in Inbound →
            </Link>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
            Close
          </button>
        </div>
        {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {error && <ErrorNote error={error} />}
        {data && (
          <div className="space-y-6">
            <TrendChart
              series={[
                { key: 'arrival', label: 'Received on time', color: 'var(--series-1)', points: data.trend.arrival },
                { key: 'ship', label: 'Shipped on time', color: 'var(--series-2)', points: data.trend.ship },
              ]}
            />
            <div className="-mx-5 border-t border-slate-200 dark:border-slate-800">
              <DataTable id="supplier-lines" rows={data.lines} columns={COLUMNS} rowKey={(l) => l.id} empty="No lines." maxHeight="55vh" />
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
