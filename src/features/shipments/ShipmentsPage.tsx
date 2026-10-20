import { useDeferredValue, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PROGRESS_BUCKETS, PROGRESS_BUCKET_LABELS, bucketsOf, type ProgressBucket } from '../../../shared/progress';
import { SHIPMENT_STATUSES, type Shipment, type ShipmentStatus } from '../../../shared/types';
import { Card, Empty, ErrorNote, PageHeader, SourceDot, SourceLegend, StatusBadge, tableCls, tdCls, thCls } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { STATUS_LABELS, arrivalDataSource, arrivalLabel, formatDate, poLineLabel } from '../../lib/format';
import { changeLabel, headlineChange } from '../../lib/progress';
import { useBranch } from '../../app/branch';
import { ProgressSummaryCard, useLatestProgress } from './ProgressSummary';
import { ShipmentDrawer } from './ShipmentDrawer';
import { TrackingLog } from './TrackingLog';
import { useTrackingRefresh } from './TrackingRefresh';

type ProgressFilter = ProgressBucket | 'changed';

function parseFilter(v: string | null): ProgressFilter | null {
  return v === 'changed' || (PROGRESS_BUCKETS as readonly string[]).includes(v ?? '') ? (v as ProgressFilter) : null;
}

export function ShipmentsPage() {
  const [status, setStatus] = useState<ShipmentStatus | 'all'>('all');
  const [carrier, setCarrier] = useState('');
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [selected, setSelected] = useState<number | null>(null);
  const { branch } = useBranch();
  // ?progress=changed|shipped|arrived|… so the import page and summary can link to a filtered view.
  const [params, setParams] = useSearchParams();
  const progressFilter = parseFilter(params.get('progress'));
  const setProgressFilter = (f: ProgressFilter | null) =>
    setParams((p) => {
      if (f) p.set('progress', f);
      else p.delete('progress');
      return p;
    });
  const [runFilter, setRunFilter] = useState<number | null>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: ['shipments', carrier, q, branch],
    queryFn: () =>
      api<Shipment[]>(`/shipments${qs({ carrier: carrier || undefined, q: q || undefined, branch: branch || undefined })}`),
  });
  const latest = useLatestProgress(branch);
  const latestImportId = latest.data?.importId ?? null;
  const tracking = useTrackingRefresh();

  const all = data ?? [];
  const changedInLatest = (s: Shipment) => latestImportId !== null && s.latestChange?.importId === latestImportId;
  const byProgress = useMemo(() => {
    if (runFilter !== null) return all.filter((s) => s.trackingRunId === runFilter);
    if (!progressFilter) return all;
    return all.filter(
      (s) => changedInLatest(s) && (progressFilter === 'changed' || bucketsOf(s.latestChange!.changes).includes(progressFilter)),
    );
  }, [all, progressFilter, runFilter, latestImportId]);
  // Status counts follow the progress filter so the tabs describe what's listed.
  const counts = useMemo(() => {
    const c: Partial<Record<ShipmentStatus, number>> = {};
    for (const s of byProgress) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [byProgress]);
  const carriers = useMemo(() => [...new Set(all.map((s) => s.carrier).filter(Boolean) as string[])].sort(), [all]);
  const rows = status === 'all' ? byProgress : byProgress.filter((s) => s.status === status);
  const hasManual = all.some((s) => s.arrivalSource === 'manual');

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
        description="Every PO line and how it has progressed across uploaded reports."
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
              aria-label="Carrier"
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="">All carriers</option>
              {carriers.map((c) => <option key={c}>{c}</option>)}
            </select>
            <select
              value={runFilter !== null ? 'run' : (progressFilter ?? '')}
              onChange={(e) => {
                setRunFilter(null);
                setProgressFilter(parseFilter(e.target.value));
              }}
              aria-label="Progress in latest upload"
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              {runFilter !== null && <option value="run">Changed by tracking refresh #{runFilter}</option>}
              <option value="">All lines</option>
              <option value="changed">Changed in latest upload</option>
              {PROGRESS_BUCKETS.map((b) => (
                <option key={b} value={b}>
                  Latest upload: {PROGRESS_BUCKET_LABELS[b]}
                </option>
              ))}
            </select>
            {tracking.buttons}
          </>
        }
      />
      {tracking.status}
      {tracking.configured && <TrackingLog selectedRunId={runFilter} onSelectRun={setRunFilter} />}
      {latest.data && (
        <ProgressSummaryCard
          summary={latest.data}
          selected={runFilter === null ? progressFilter : null}
          onSelect={(f) => {
            setRunFilter(null);
            setProgressFilter(f);
          }}
        />
      )}
      {error && <ErrorNote error={error} />}

      <div className="flex flex-wrap gap-2">
        {tab('all', 'All', byProgress.length)}
        {SHIPMENT_STATUSES.filter((s) => counts[s]).map((s) => tab(s, STATUS_LABELS[s], counts[s]!))}
      </div>

      <SourceLegend
        sources={hasManual ? ['manual'] : []}
        extra={
          latestImportId !== null && (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-5 rounded-sm bg-violet-100 dark:bg-violet-900/60" aria-hidden />
              Changed in the latest upload{latest.data ? ` (${formatDate(latest.data.reportDate)})` : ''}
            </span>
          )
        }
      />

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <div className="p-6 text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-4"><Empty>No shipments match.</Empty></div>
        ) : (
          <table className={tableCls}>
            <thead>
              <tr>
                {[...(branch ? [] : ['Branch']), 'Status', 'Supplier', 'PO / line', 'ASN', 'Part', 'Carrier', 'Tracking', 'ETA', 'Arrived', 'Latest change'].map((h) => (
                  <th key={h} className={`${thCls} whitespace-nowrap`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const fresh = changedInLatest(s);
                const head = s.latestChange && headlineChange(s.latestChange.changes);
                const more = (s.latestChange?.changes.length ?? 0) - 1;
                return (
                  <tr
                    key={s.id}
                    onClick={() => setSelected(s.id)}
                    className={`cursor-pointer ${fresh ? 'bg-violet-50 hover:bg-violet-100 dark:bg-violet-950/40 dark:hover:bg-violet-950/70' : 'hover:bg-slate-50 dark:hover:bg-slate-900'}`}
                  >
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
                      <SourceDot source={arrivalDataSource(s)} />
                      {arrivalLabel(s)}
                      {s.arrivalSource === 'report_window' || s.arrivalSource === 'eta' ? <span className="ml-1 text-xs text-slate-500">est.</span> : null}
                    </td>
                    <td
                      className={`${tdCls} text-xs`}
                      title={s.latestChange ? s.latestChange.changes.map(changeLabel).join('\n') : undefined}
                    >
                      {head ? (
                        <>
                          <span className={fresh ? 'font-medium text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300'}>
                            {changeLabel(head)}
                          </span>
                          {more > 0 && <span className="text-slate-500"> +{more}</span>}
                          <span className="block text-slate-500">{formatDate(s.latestChange!.reportDate, { year: undefined })} report</span>
                        </>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      {selected !== null && <ShipmentDrawer id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
