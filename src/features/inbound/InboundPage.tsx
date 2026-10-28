import { useDeferredValue, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { addDays, todayIso } from '../../../shared/dates';
import { PROGRESS_BUCKETS, PROGRESS_BUCKET_LABELS, bucketsOf, type ProgressBucket } from '../../../shared/progress';
import { estimatedShare, mergeSummaries, type PalletSummary } from '../../../shared/pallets';
import { SHIPMENT_STATUSES, TRACKING_LABELS, type InboundDay, type InboundResponse, type InboundShipment, type TrackingLabel } from '../../../shared/types';
import { useBranch } from '../../app/branch';
import { DataTable, type Column } from '../../components/DataTable';
import { ActiveFilters, ChipGroup, FilterSelect, SearchBox, useUrlFilters, type ActiveFilter } from '../../components/filters';
import { DataQualityNote, MetricToggle, useStoredChoice } from '../../components/pallets';
import { BasisBadge, Card, DateInput, Empty, ErrorNote, PageHeader, SourceDot, SourceLegend, StatTile, StatusBadge, TrackingBadge } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { STATUS_LABELS, TRACKING_LABEL_TEXT, arrivalDataSource, arrivalLabel, formatDate, formatPallets, poLineLabel } from '../../lib/format';
import { changeLabel, headlineChange } from '../../lib/progress';
import { ProgressSummaryCard, useLatestProgress } from '../shipments/ProgressSummary';
import { ShipmentDrawer } from '../shipments/ShipmentDrawer';
import { TrackingLog } from '../shipments/TrackingLog';
import { useTrackingRefresh } from '../shipments/TrackingRefresh';
import { BranchSummaryTable } from './BranchSummaryTable';
import { InboundByPartTable } from './InboundByPartTable';
import { InboundChart, METRICS, type Metric } from './InboundChart';

const METRIC_LABELS: Record<Metric, string> = { pallets: 'Pallets', units: 'Units', lines: 'Lines' };
type ChangedFilter = ProgressBucket | 'changed';
const parseChanged = (v: string | null): ChangedFilter | null =>
  v === 'changed' || (PROGRESS_BUCKETS as readonly string[]).includes(v ?? '') ? (v as ChangedFilter) : null;
/** Which lines the table lists: expected in the date range (default), not dated yet, or every line. */
const DATE_SCOPES = ['undated', 'all'] as const;
type DateScope = (typeof DATE_SCOPES)[number] | null;
const FILTER_KEYS = ['date', 'dates', 'status', 'supplier', 'carrier', 'part', 'branch', 'changed', 'tracking', 'late'];

const expected = (s: InboundShipment) => s.estimatedArrivalDate ?? s.promisedArrivalDate;

function rangeSum(days: InboundDay[], from: string, to: string): PalletSummary {
  return mergeSummaries(days.filter((d) => d.date >= from && d.date <= to).map((d) => d.pallets));
}
function countBy<T>(rows: T[], key: (r: T) => string | null) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: value, count }));
}

/**
 * Every PO line coming in: the arrival chart, what the latest upload changed, carrier tracking,
 * and one table of lines (including those not shipped yet) that the chart and filters narrow down.
 */
export function InboundPage() {
  const today = todayIso();
  const [params] = useSearchParams();
  const [from, setFrom] = useState(params.get('from') ?? addDays(today, -7));
  const [to, setTo] = useState(params.get('to') ?? addDays(today, 21));
  const f = useUrlFilters();
  const date = f.get('date');
  const scope = (DATE_SCOPES as readonly string[]).includes(f.get('dates') ?? '') ? (f.get('dates') as DateScope) : null;
  const status = f.get('status');
  const supplier = f.get('supplier');
  const carrier = f.get('carrier');
  const part = f.get('part');
  const branchFilter = f.get('branch');
  const changed = parseChanged(f.get('changed'));
  const trackingFilter = f.get('tracking') as TrackingLabel | null;
  const late = f.get('late') === '1';
  const [runFilter, setRunFilter] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim().toLowerCase());
  const [selected, setSelected] = useState<number | null>(null);
  const [metric, setMetric] = useStoredChoice<Metric>('inbound-metric', METRICS, 'pallets');
  const { branch } = useBranch();

  const byDay = useQuery({
    queryKey: ['inbound-by-day', from, to, branch],
    queryFn: () => api<InboundResponse>(`/reports/inbound-by-day${qs({ from, to, branch: branch || undefined })}`),
  });
  const lines = useQuery({
    queryKey: ['shipments', branch],
    queryFn: () => api<InboundShipment[]>(`/shipments${qs({ branch: branch || undefined })}`),
  });
  const latest = useLatestProgress(branch);
  const latestImportId = latest.data?.importId ?? null;
  const tracking = useTrackingRefresh();

  const days = byDay.data?.days ?? [];
  const parts = byDay.data?.parts ?? [];
  const todayCount = days.find((d) => d.date === today)?.total ?? 0;
  const nextWeek = days.filter((d) => d.date > today && d.date <= addDays(today, 7)).reduce((n, d) => n + d.total, 0);
  const overdue = days.filter((d) => d.date < today).reduce((n, d) => n + d.shipments.filter((s) => !s.actualArrivalDate).length, 0);
  const inRange = mergeSummaries(days.map((d) => d.pallets));
  const todaySum = rangeSum(days, today, today);
  const weekSum = rangeSum(days, addDays(today, 1), addDays(today, 7));
  const estPct = Math.round(estimatedShare(inRange) * 100);

  const all = lines.data ?? [];
  const changedInLatest = (s: InboundShipment) => latestImportId !== null && s.latestChange?.importId === latestImportId;
  // Date scope first, so the other filters' counts describe what the table can show.
  const scoped = useMemo(
    () =>
      all.filter((s) => {
        const d = expected(s);
        if (date) return d === date;
        if (late) return !!d && d < today && !s.actualArrivalDate;
        if (scope === 'all' || changed || runFilter !== null) return true;
        if (scope === 'undated') return !d;
        return !!d && d >= from && d <= to;
      }),
    [all, date, scope, from, to, changed, runFilter, late, today],
  );
  const rows = useMemo(
    () =>
      scoped.filter(
        (s) =>
          (runFilter === null || s.trackingRunId === runFilter) &&
          (!status || s.status === status) &&
          (!supplier || s.supplier === supplier) &&
          (!carrier || s.carrier === carrier) &&
          (!part || s.partNumber === part) &&
          (!branchFilter || s.branch === branchFilter) &&
          (!trackingFilter || s.tracking?.label === trackingFilter) &&
          (!changed || (changedInLatest(s) && (changed === 'changed' || bucketsOf(s.latestChange!.changes).includes(changed)))) &&
          (!q || [s.trackingNumber, s.trackingRef, s.poNumber, s.asn, s.partNumber, s.customerPo, s.supplier].some((v) => v?.toLowerCase().includes(q))),
      ),
    [scoped, runFilter, status, supplier, carrier, part, branchFilter, trackingFilter, changed, latestImportId, q],
  );
  const undated = all.filter((s) => !expected(s)).length;
  const statusCounts = countBy(scoped, (s) => s.status);
  const legendSources = [
    ...(all.some((s) => s.trackingFound) ? (['tracking'] as const) : []),
    ...(all.some((s) => s.arrivalSource === 'manual') ? (['manual'] as const) : []),
  ];

  const active: ActiveFilter[] = [
    date && { key: 'date', label: `Expected ${formatDate(date, { weekday: 'short', year: undefined })}`, onClear: () => f.set('date', null) },
    late && { key: 'late', label: 'Past due, not arrived', onClear: () => f.set('late', null) },
    runFilter !== null && { key: 'run', label: `Changed by tracking refresh #${runFilter}`, onClear: () => setRunFilter(null) },
    supplier && { key: 'supplier', label: supplier, onClear: () => f.set('supplier', null) },
    carrier && { key: 'carrier', label: carrier, onClear: () => f.set('carrier', null) },
    part && { key: 'part', label: `Part ${part}`, onClear: () => f.set('part', null) },
    branchFilter && { key: 'branch', label: branchFilter, onClear: () => f.set('branch', null) },
    changed && { key: 'changed', label: changed === 'changed' ? 'Changed in latest upload' : `Latest upload: ${PROGRESS_BUCKET_LABELS[changed]}`, onClear: () => f.set('changed', null) },
    trackingFilter && { key: 'tracking', label: TRACKING_LABEL_TEXT[trackingFilter], onClear: () => f.set('tracking', null) },
  ].filter(Boolean) as ActiveFilter[];

  return (
    <div className="space-y-6">
      <PageHeader
        title={branch ? `Inbound · ${branch}` : 'Inbound'}
        description="Every supplier PO line: when it is expected (carrier ETA when known, otherwise the supplier's ETA), how it moved in the latest upload, and its tracking."
        actions={
          <>
            <MetricToggle options={METRICS} labels={METRIC_LABELS} value={metric} onChange={setMetric} />
            <DateInput label="From" value={from} onChange={setFrom} />
            <DateInput label="To" value={to} onChange={setTo} />
            {tracking.buttons}
          </>
        }
      />
      {tracking.status}
      {byDay.error && <ErrorNote error={byDay.error} />}
      {lines.error && <ErrorNote error={lines.error} />}

      {latest.data && (
        <ProgressSummaryCard
          summary={latest.data}
          selected={runFilter === null ? changed : null}
          onSelect={(c) => {
            setRunFilter(null);
            f.update({ changed: c, date: null });
          }}
        />
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {metric === 'lines' && (
          <>
            <StatTile label="Expected today" value={todayCount} />
            <StatTile label="Next 7 days" value={nextWeek} />
            <StatTile label="Past due, not arrived" value={overdue} hint="Expected date passed in this range" warn={overdue > 0} />
            <StatTile label="Not shipped, no date yet" value={undated.toLocaleString()} />
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
            <StatTile label="Pallets in range" value={formatPallets(inRange.palletEq)} hint={`${inRange.fullPallets} full + ${inRange.partialPallets} partial (may be combined)`} />
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

      <Card>
        {byDay.isLoading ? (
          <div className="h-72 animate-pulse rounded-md bg-slate-100 dark:bg-slate-900" />
        ) : days.length === 0 ? (
          <Empty>No inbound shipments in this range. Import a report to get started.</Empty>
        ) : (
          <InboundChart days={days} metric={metric} selected={date} onSelectDay={(d) => f.update({ date: d, dates: null, late: null })} />
        )}
      </Card>

      {tracking.configured && <TrackingLog selectedRunId={runFilter} onSelectRun={setRunFilter} />}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <ChipGroup
            label="Lines"
            value={late ? 'late' : date ? 'day' : scope}
            options={[
              ...(late ? [{ value: 'late', label: 'Past due, not arrived' }] : []),
              ...(date ? [{ value: 'day', label: formatDate(date, { weekday: 'short', year: undefined }) }] : []),
              { value: null, label: 'Expected in range' },
              { value: 'undated', label: 'No date yet', count: undated },
              { value: 'all', label: 'All lines', count: all.length },
            ]}
            onChange={(v) => v !== 'day' && v !== 'late' && f.update({ dates: v, date: null, late: null })}
          />
          <span className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-800" aria-hidden />
          <ChipGroup
            label="Status"
            value={status}
            options={[{ value: null, label: 'Any status', count: scoped.length }, ...SHIPMENT_STATUSES.filter((s) => statusCounts.some((c) => c.value === s)).map((s) => ({ value: s, label: STATUS_LABELS[s], count: statusCounts.find((c) => c.value === s)!.count }))]}
            onChange={(v) => f.set('status', v)}
          />
        </div>
        <ActiveFilters
          filters={active}
          onClearAll={() => {
            setRunFilter(null);
            f.clear(FILTER_KEYS);
          }}
        />
      </div>

      <Card className="p-0">
        {lines.isLoading ? (
          <div className="p-6 text-sm text-slate-500">Loading…</div>
        ) : (
          <DataTable
            id="inbound-lines"
            rows={rows}
            columns={lineColumns(!branch, tracking.configured, changedInLatest)}
            rowKey={(s) => s.id}
            onRowClick={(s) => setSelected(s.id)}
            highlight={changedInLatest}
            empty="No PO lines match these filters."
            toolbar={
              <>
                <SearchBox value={search} onChange={setSearch} placeholder="Search tracking, PO, ASN, part, supplier" />
                <FilterSelect label="Supplier" value={supplier} options={countBy(scoped, (s) => s.supplier)} onChange={(v) => f.set('supplier', v)} />
                <FilterSelect label="Carrier" value={carrier} options={countBy(scoped, (s) => s.carrier)} onChange={(v) => f.set('carrier', v)} />
                <FilterSelect label="Part" value={part} options={countBy(scoped, (s) => s.partNumber)} onChange={(v) => f.set('part', v)} />
                {!branch && <FilterSelect label="Branch" value={branchFilter} options={countBy(scoped, (s) => s.branch)} onChange={(v) => f.set('branch', v)} />}
                <FilterSelect
                  label="Latest upload"
                  value={changed}
                  options={[{ value: 'changed', label: 'Any change' }, ...PROGRESS_BUCKETS.map((b) => ({ value: b, label: PROGRESS_BUCKET_LABELS[b] }))]}
                  onChange={(v) => f.set('changed', v)}
                />
                {tracking.configured && (
                  <FilterSelect
                    label="Tracking"
                    value={trackingFilter}
                    options={TRACKING_LABELS.filter((l) => l !== 'no_tracking')
                      .map((l) => ({ value: l, label: TRACKING_LABEL_TEXT[l], count: scoped.filter((s) => s.tracking?.label === l).length }))
                      .filter((o) => o.count || o.value === trackingFilter)}
                    onChange={(v) => f.set('tracking', v)}
                  />
                )}
              </>
            }
          />
        )}
        <div className="px-4 py-2">
          <SourceLegend
            sources={legendSources}
            extra={
              latestImportId !== null && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-3 w-5 rounded-sm bg-violet-100 dark:bg-violet-900/60" aria-hidden />
                  Changed in the latest upload{latest.data ? ` (${formatDate(latest.data.reportDate)})` : ''}
                </span>
              )
            }
          />
        </div>
      </Card>

      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-slate-600 dark:text-slate-300">By part, in the date range</summary>
        <div className="mt-3">
          <InboundByPartTable parts={parts} />
        </div>
      </details>
      {!branch && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-slate-600 dark:text-slate-300">By branch</summary>
          <div className="mt-3">
            <BranchSummaryTable />
          </div>
        </details>
      )}

      {selected !== null && <ShipmentDrawer id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function lineColumns(showBranch: boolean, trackingConfigured: boolean, fresh: (s: InboundShipment) => boolean): Column<InboundShipment>[] {
  const cols: Column<InboundShipment>[] = [
    { id: 'po', label: 'PO / line', sortValue: (s) => poLineLabel(s), render: (s) => <span className="whitespace-nowrap">{poLineLabel(s)}</span> },
    {
      id: 'status',
      label: 'Status',
      sortValue: (s) => STATUS_LABELS[s.status],
      render: (s) => (
        <span className="whitespace-nowrap" title={s.lastTrackedAt ? `${s.trackingFound ? 'Tracked' : 'Not found'} by ${s.trackingProvider ?? 'carrier'}, checked ${new Date(s.lastTrackedAt).toLocaleString()}` : undefined}>
          <SourceDot source={s.trackingFound ? 'tracking' : null} />
          <StatusBadge status={s.status} />
        </span>
      ),
    },
    { id: 'supplier', label: 'Supplier', sortValue: (s) => s.supplier, render: (s) => s.supplier },
  ];
  if (showBranch) cols.push({ id: 'branch', label: 'Branch', sortValue: (s) => s.branch, render: (s) => s.branch ?? '—', className: 'whitespace-nowrap text-xs' });
  cols.push(
    { id: 'asn', label: 'ASN', sortValue: (s) => s.asn, render: (s) => s.asn ?? '—', className: 'font-mono text-xs', defaultHidden: true },
    { id: 'part', label: 'Part', sortValue: (s) => s.partNumber, render: (s) => s.partNumber ?? '—', className: 'whitespace-nowrap text-xs' },
    { id: 'description', label: 'Description', sortValue: (s) => s.itemDescription, render: (s) => <span className="block max-w-48 truncate text-xs" title={s.itemDescription ?? undefined}>{s.itemDescription ?? '—'}</span>, defaultHidden: true },
    { id: 'qty', label: 'Qty', align: 'right', sortValue: (s) => s.quantity, render: (s) => s.quantity?.toLocaleString() ?? '—' },
    {
      id: 'pallets',
      label: 'Pallets',
      align: 'right',
      sortValue: (s) => s.pallets.palletEq,
      render: (s) => (
        <span className="whitespace-nowrap">
          {s.pallets.palletEq != null && <span className="mr-2">{formatPallets(s.pallets.palletEq)}</span>}
          {s.pallets.basis !== 'real' && <BasisBadge basis={s.pallets.basis} estimate={s.pallets.estimate} short />}
        </span>
      ),
    },
    { id: 'carrier', label: 'Carrier', sortValue: (s) => s.carrier, render: (s) => s.carrier ?? '—' },
    {
      id: 'tracking',
      label: 'Tracking',
      sortValue: (s) => s.trackingNumber,
      render: (s) => (
        <span className="text-xs">
          <span className="font-mono">{s.trackingNumber ?? '—'}</span>
          {trackingConfigured && s.trackingNumber && (
            <span className="mt-1 block">
              <TrackingBadge tracking={s.tracking} />
            </span>
          )}
        </span>
      ),
      defaultHidden: true,
    },
    { id: 'etd', label: 'ETD', title: "Supplier's ship date", sortValue: (s) => s.shipDate, render: (s) => <span className="whitespace-nowrap">{formatDate(s.shipDate)}</span>, defaultHidden: true },
    {
      id: 'eta',
      label: 'ETA',
      title: 'Carrier ETA when known, otherwise the supplier ETA',
      sortValue: expected,
      render: (s) => (
        <span className="whitespace-nowrap" title={s.estimatedArrivalDate ? `Carrier ETA; supplier ETA ${formatDate(s.promisedArrivalDate)}` : undefined}>
          <SourceDot source={s.estimatedArrivalDate ? 'tracking' : null} />
          {formatDate(expected(s))}
        </span>
      ),
    },
    { id: 'promised', label: 'Supplier ETA', sortValue: (s) => s.promisedArrivalDate, render: (s) => <span className="whitespace-nowrap">{formatDate(s.promisedArrivalDate)}</span>, defaultHidden: true },
    {
      id: 'arrived',
      label: 'Arrived',
      sortValue: (s) => s.actualArrivalDate,
      render: (s) => (
        <span className="whitespace-nowrap">
          <SourceDot source={arrivalDataSource(s)} />
          {arrivalLabel(s)}
          {s.arrivalSource === 'report_window' || s.arrivalSource === 'eta' ? <span className="ml-1 text-xs text-slate-500">est.</span> : null}
        </span>
      ),
    },
    {
      id: 'change',
      label: 'Latest change',
      sortValue: (s) => s.latestChange?.reportDate ?? null,
      render: (s) => {
        const head = s.latestChange && headlineChange(s.latestChange.changes);
        if (!head) return <span className="text-slate-400">—</span>;
        const more = s.latestChange!.changes.length - 1;
        return (
          <span className="text-xs" title={s.latestChange!.changes.map(changeLabel).join('\n')}>
            <span className={fresh(s) ? 'font-medium text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300'}>{changeLabel(head)}</span>
            {more > 0 && <span className="text-slate-500"> +{more}</span>}
            <span className="block text-slate-500">{formatDate(s.latestChange!.reportDate, { year: undefined })} report</span>
          </span>
        );
      },
    },
    { id: 'customerPo', label: 'Customer PO', sortValue: (s) => s.customerPo, render: (s) => s.customerPo ?? '—', className: 'font-mono text-xs', defaultHidden: true },
  );
  return cols;
}
