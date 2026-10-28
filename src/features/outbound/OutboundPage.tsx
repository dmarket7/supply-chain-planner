import { Fragment, useDeferredValue, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { addDays, daysBetween, todayIso } from '../../../shared/dates';
import { matchesChangeFilter, ORDER_CHANGE_FILTERS, type OrderChangeFilter } from '../../../shared/orderChanges';
import { estimatedShare, mergeSummaries, mergeTrucks } from '../../../shared/pallets';
import { READINESS, type Readiness } from '../../../shared/supply';
import type { OutboundOrder, OutboundPart, OutboundResponse, OutboundShipTo } from '../../../shared/types';
import { useBranch } from '../../app/branch';
import { DataTable, type Column } from '../../components/DataTable';
import { ActiveFilters, ChipGroup, FilterSelect, SearchBox, useUrlFilters, type ActiveFilter } from '../../components/filters';
import { DataQualityNote, MetricToggle, useStoredChoice } from '../../components/pallets';
import { READINESS_GROUPS, ReadinessBadge, ReadinessBar, readinessReason } from '../../components/readiness';
import { BasisBadge, Card, DateInput, Empty, ErrorNote, PageHeader, StatTile, tableCls, tdCls, thCls } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { formatDate, formatPallets } from '../../lib/format';
import { describeCauses, describeChange, leadChange, shipDateShift } from '../../lib/orderChanges';
import { OrderDrawer } from './OrderDrawer';
import { OUTBOUND_METRICS, OutboundChart, type OutboundMetric } from './OutboundChart';

const METRIC_LABELS: Record<OutboundMetric, string> = { pallets: 'Pallets', trucks: 'Trucks', units: 'Units' };

const STATUS_STYLES: Record<string, string> = {
  'Reserved Physical': 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  'Reserved ordered': 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  'On order': 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
};
const STATUS_HINTS: Record<string, string> = {
  'Reserved Physical': 'Reserved from stock on hand',
  'Reserved ordered': 'Reserved against an inbound PO',
  'On order': 'Not yet reserved',
};

function OrderStatus({ status }: { status: string | null }) {
  const s = status ?? 'Unknown';
  return (
    <span title={STATUS_HINTS[s]} className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[s] ?? STATUS_STYLES['On order']}`}>
      {s}
    </span>
  );
}

const right = `${tdCls} text-right tabular-nums`;

/** `?readiness=late,short` limits the orders to those states. */
function parseReadiness(v: string | null): Readiness[] {
  return (v ?? '').split(',').filter((r): r is Readiness => (READINESS as readonly string[]).includes(r));
}
const READINESS_FILTERS = [
  { label: 'All orders', value: null },
  { label: 'At risk', value: 'late,short' },
  { label: 'No ETA', value: 'noEta' },
  { label: 'Short', value: 'short' },
];
const CHANGE_LABELS: Record<OrderChangeFilter, string> = {
  any: 'Any change',
  pushed: 'Ship date pushed out',
  pulled: 'Ship date pulled in',
  dock: 'Customer moved dock date',
  new: 'New order',
};
const isChangeFilter = (v: string | null): v is OrderChangeFilter => (ORDER_CHANGE_FILTERS as readonly string[]).includes(v ?? '');
const FILTER_KEYS = ['date', 'shipTo', 'part', 'status', 'readiness', 'changed', 'late'];

const canShipShare = (s: OutboundShipTo) => {
  const total = Object.values(s.readiness).reduce((n, r) => n + (r?.units ?? 0), 0);
  const ok = READINESS_GROUPS[0].members.reduce((n, r) => n + (s.readiness[r]?.units ?? 0), 0);
  return total ? Math.round((ok / total) * 100) : null;
};
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** Days the ship date falls after the customer's requested dock date; positive = after. */
export function requestGap(o: Pick<OutboundOrder, 'shipDate' | 'dockDate'>): number | null {
  return o.shipDate && o.dockDate ? daysBetween(o.dockDate, o.shipDate) : null;
}

function countBy<T>(rows: T[], key: (r: T) => string | null) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: value, count }));
}

export function OutboundPage() {
  const today = todayIso();
  const [params] = useSearchParams();
  const [from, setFrom] = useState(params.get('from') ?? addDays(today, -7));
  const [to, setTo] = useState(params.get('to') ?? addDays(today, 28));
  const f = useUrlFilters();
  const date = f.get('date');
  const shipTo = f.get('shipTo');
  const part = f.get('part');
  const status = f.get('status');
  const readinessParam = f.get('readiness');
  const readiness = parseReadiness(readinessParam);
  const changedParam = f.get('changed');
  const changed = isChangeFilter(changedParam) ? changedParam : null;
  const late = f.get('late') === '1';
  const view = f.get('view') === 'shipto' ? 'shipto' : 'orders';
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim().toLowerCase());
  const [openOrder, setOpenOrder] = useState<OutboundOrder | null>(null);
  const [metric, setMetric] = useStoredChoice<OutboundMetric>('outbound-metric', OUTBOUND_METRICS, 'pallets');
  const { branch } = useBranch();

  const { data, error, isLoading } = useQuery({
    queryKey: ['outbound', from, to, branch],
    queryFn: () => api<OutboundResponse>(`/reports/outbound${qs({ from, to, branch: branch || undefined })}`),
  });
  const days = data?.days ?? [];
  const shipTos = data?.shipTos ?? [];
  const week = days.filter((d) => d.date >= today && d.date <= addDays(today, 7));
  const weekPallets = mergeSummaries(week.map((d) => d.pallets));
  const weekTrucks = mergeTrucks(week.map((d) => d.trucks));
  const inRange = mergeSummaries(days.map((d) => d.pallets));
  const estPct = Math.round(estimatedShare(inRange) * 100);
  const parts = [...new Map(shipTos.flatMap((s) => s.parts).map((p) => [p.cpn ?? p.mpn, p])).values()];
  const snapshot = data?.snapshot;
  const summary = snapshot?.changes?.summary;
  const hasInventory = !!data?.inventoryReportDate;

  const orders = useMemo(() => shipTos.flatMap((s) => s.lines).sort((a, b) => a.shipDate!.localeCompare(b.shipDate!) || a.soNumber.localeCompare(b.soNumber)), [shipTos]);
  const matching = useMemo(
    () =>
      orders.filter(
        (o) =>
          (!date || o.shipDate === date) &&
          (!shipTo || (o.shipTo ?? 'Unknown') === shipTo) &&
          (!part || o.cpn === part || o.mpn === part) &&
          (!status || o.status === status) &&
          (!readiness.length || (o.supply && readiness.includes(o.supply.readiness))) &&
          (!changed || matchesChangeFilter(o.changes, changed)) &&
          (!late || (requestGap(o) ?? 0) > 0) &&
          (!q || [o.soNumber, o.emsPo, o.cpn, o.mpn, o.shipTo, o.itemName].some((v) => v?.toLowerCase().includes(q))),
      ),
    [orders, date, shipTo, part, status, readinessParam, changed, late, q],
  );
  const matchUnits = matching.reduce((n, o) => n + o.quantity, 0);
  const matchPallets = matching.reduce((n, o) => n + (o.pallets.palletEq ?? 0), 0);

  const active: ActiveFilter[] = [
    date && { key: 'date', label: `Ships ${formatDate(date, { weekday: 'short', year: undefined })}`, onClear: () => f.set('date', null) },
    shipTo && { key: 'shipTo', label: shipTo, onClear: () => f.set('shipTo', null) },
    part && { key: 'part', label: `Part ${part}`, onClear: () => f.set('part', null) },
    status && { key: 'status', label: status, onClear: () => f.set('status', null) },
    readiness.length > 0 && { key: 'readiness', label: READINESS_FILTERS.find((r) => r.value === readinessParam)?.label ?? readinessParam!, onClear: () => f.set('readiness', null) },
    changed && { key: 'changed', label: CHANGE_LABELS[changed], onClear: () => f.set('changed', null) },
    late && { key: 'late', label: 'Ships after customer request', onClear: () => f.set('late', null) },
  ].filter(Boolean) as ActiveFilter[];

  return (
    <div className="space-y-6">
      <PageHeader
        title={branch ? `Outbound · ${branch}` : 'Outbound'}
        description="Open sales orders from the report's ODM Open Order tab, by ship date (Wintec confirmed, else system scheduled) and ship-to. Orders to the same ship-to on the same day share trucks."
        actions={
          <>
            <MetricToggle options={OUTBOUND_METRICS} labels={METRIC_LABELS} value={metric} onChange={setMetric} />
            <DateInput label="From" value={from} onChange={setFrom} />
            <DateInput label="To" value={to} onChange={setTo} />
          </>
        }
      />
      {error && <ErrorNote error={error} />}

      {data && !snapshot ? (
        <Empty>
          No outbound orders yet. <Link to="/import" className="underline">Import a report</Link> that has the ODM Open Order tab.
        </Empty>
      ) : (
        <>
          {snapshot && (
            <p className="text-sm text-slate-500">
              As of the {formatDate(snapshot.reportDate)} report · {plural(snapshot.orderCount, 'sales order')}
              {hasInventory ? ` · stock checked against the ${formatDate(data!.inventoryReportDate)} inventory` : ' · import a report with the Inventory Summary tab to check stock'}
            </p>
          )}
          {snapshot?.changes && summary && (
            <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <span className="text-slate-500">Since the {formatDate(snapshot.changes.previousReportDate)} report:</span>
              <ChangeLink n={summary.pushedOut} label="ship date pushed out" onClick={() => f.set('changed', 'pushed')} warn />
              <ChangeLink n={summary.pulledIn} label="pulled in" onClick={() => f.set('changed', 'pulled')} />
              <ChangeLink n={summary.dockMoved} label="customer moved the dock date" onClick={() => f.set('changed', 'dock')} />
              <ChangeLink n={summary.added} label="new" onClick={() => f.set('changed', 'new')} />
              <span>
                <span className="tabular-nums">{snapshot.changes.noLongerListed.toLocaleString()}</span> SOs no longer listed (shipped or cancelled)
              </span>
              {summary.noCause > 0 && (
                <span className="text-slate-500">
                  {summary.noCause.toLocaleString()} date move{summary.noCause === 1 ? '' : 's'} with no cause in the report; open an order to add a note
                </span>
              )}
            </Card>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Pallets next 7 days" value={formatPallets(weekPallets.palletEq)} hint={`${weekPallets.fullPallets} full + ${weekPallets.partialPallets} partial`} />
            <StatTile label="Trucks next 7 days" value={weekTrucks.trucksNeeded.toLocaleString()} hint={`${formatPallets(weekTrucks.truckloads)} truckloads`} />
            <StatTile
              label="Overdue at report date"
              value={(data?.overdue.orders ?? 0).toLocaleString()}
              warn={(data?.overdue.orders ?? 0) > 0}
              hint={data ? `${formatPallets(data.overdue.pallets.palletEq)} pallets · ${data.overdue.trucks.trucksNeeded} trucks; still open with a ship date before the report` : undefined}
            />
            <StatTile
              label="Estimated"
              value={`${estPct}%`}
              warn={inRange.estimatedLines > 0 || inRange.noRatioLines > 0}
              hint={`of pallets in range${data?.unscheduled.orders ? ` · ${plural(data.unscheduled.orders, 'order')} unscheduled` : ''}`}
            />
          </div>

          <DataQualityNote sum={inRange} parts={parts} />

          <Card>
            {isLoading ? (
              <div className="h-72 animate-pulse rounded-md bg-slate-100 dark:bg-slate-900" />
            ) : days.length === 0 ? (
              <Empty>No open sales orders ship in this range.</Empty>
            ) : (
              <OutboundChart days={days} metric={metric} selected={date} onSelectDay={(d) => f.set('date', d)} />
            )}
          </Card>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <ChipGroup label="View" value={view} options={[{ value: 'orders', label: 'Orders' }, { value: 'shipto', label: 'By ship-to' }]} onChange={(v) => f.set('view', v === 'shipto' ? v : null)} />
              {hasInventory && (
                <>
                  <span className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-800" aria-hidden />
                  <ChipGroup label="Can it ship?" value={readinessParam} options={READINESS_FILTERS} onChange={(v) => f.set('readiness', v)} />
                </>
              )}
            </div>
            <ActiveFilters filters={active} onClearAll={() => f.clear(FILTER_KEYS)} />
          </div>

          {view === 'shipto' ? (
            shipTos.length > 0 && <ShipToTable shipTos={shipTos} showReadiness={hasInventory} onShowOrders={(s) => f.update({ shipTo: s, view: null })} />
          ) : (
            <Card className="p-0">
              <DataTable
                id="outbound-orders"
                rows={matching}
                columns={orderColumns(hasInventory)}
                rowKey={(o) => o.id}
                onRowClick={setOpenOrder}
                highlight={(o) => o.changes.length > 0}
                empty={orders.length ? 'No orders match these filters.' : 'No open sales orders ship in this range.'}
                toolbar={
                  <>
                    <SearchBox value={search} onChange={setSearch} placeholder="Search SO, EMS PO, part, ship-to" />
                    <FilterSelect label="Ship to" value={shipTo} options={countBy(orders, (o) => o.shipTo ?? 'Unknown')} onChange={(v) => f.set('shipTo', v)} />
                    <FilterSelect label="Part" value={part} options={countBy(orders, (o) => o.cpn)} onChange={(v) => f.set('part', v)} />
                    <FilterSelect label="Reservation" value={status} options={countBy(orders, (o) => o.status)} onChange={(v) => f.set('status', v)} />
                    <FilterSelect
                      label="Changed"
                      value={changed}
                      options={ORDER_CHANGE_FILTERS.map((c) => ({ value: c, label: CHANGE_LABELS[c], count: orders.filter((o) => matchesChangeFilter(o.changes, c)).length }))}
                      onChange={(v) => f.set('changed', v)}
                    />
                    <label className="flex items-center gap-1 text-sm text-slate-600 dark:text-slate-300">
                      <input type="checkbox" checked={late} onChange={(e) => f.set('late', e.target.checked ? '1' : null)} />
                      Ships after customer request
                    </label>
                    <span className="text-xs tabular-nums text-slate-500">
                      {matchUnits.toLocaleString()} units · {formatPallets(matchPallets)} pallets
                    </span>
                  </>
                }
              />
              <p className="px-4 py-2 text-xs text-slate-500">
                Tinted rows changed since the previous report. Click an order for how its dates moved and why, and to add a note.
                {data?.unscheduled.orders ? ` ${plural(data.unscheduled.orders, 'unscheduled order')} with no ship date are not listed.` : ''}
              </p>
            </Card>
          )}
        </>
      )}
      {openOrder && <OrderDrawer soNumber={openOrder.soNumber} cpn={openOrder.cpn} onClose={() => setOpenOrder(null)} />}
    </div>
  );
}

function ChangeLink({ n, label, onClick, warn = false }: { n: number; label: string; onClick: () => void; warn?: boolean }) {
  if (!n) return null;
  return (
    <button onClick={onClick} className={`hover:underline ${warn ? 'text-amber-700 dark:text-amber-300' : ''}`}>
      <span className="font-medium tabular-nums">{n.toLocaleString()}</span> {label}
    </button>
  );
}

function orderColumns(hasInventory: boolean): Column<OutboundOrder>[] {
  const mono = 'whitespace-nowrap font-mono text-xs';
  const cols: Column<OutboundOrder>[] = [
    { id: 'so', label: 'Wintec SO#', sortValue: (o) => o.soNumber, render: (o) => o.soNumber, className: mono },
    { id: 'shipTo', label: 'Ship to', sortValue: (o) => o.shipTo, render: (o) => <span className="block max-w-56 truncate" title={o.shipTo ?? undefined}>{o.shipTo ?? '—'}</span> },
    { id: 'emsPo', label: 'EMS PO#', sortValue: (o) => o.emsPo, render: (o) => o.emsPo ?? '—', className: mono, defaultHidden: true },
    { id: 'cpn', label: 'CPN', sortValue: (o) => o.cpn, render: (o) => o.cpn ?? '—', className: mono },
    { id: 'mpn', label: 'MPN', sortValue: (o) => o.mpn, render: (o) => o.mpn ?? '—', className: mono },
    { id: 'item', label: 'Item', sortValue: (o) => o.itemName, render: (o) => <span className="block max-w-48 truncate text-xs" title={o.itemName ?? undefined}>{o.itemName ?? '—'}</span>, defaultHidden: true },
    { id: 'status', label: 'Reservation', sortValue: (o) => o.status, render: (o) => <OrderStatus status={o.status} /> },
    { id: 'qty', label: 'Qty', align: 'right', sortValue: (o) => o.quantity, render: (o) => o.quantity.toLocaleString() },
    {
      id: 'pallets',
      label: 'Pallets',
      align: 'right',
      sortValue: (o) => o.pallets.palletEq,
      render: (o) => (
        <span className="whitespace-nowrap">
          {o.pallets.palletEq != null && <span className="mr-2">{formatPallets(o.pallets.palletEq)}</span>}
          {o.pallets.basis !== 'real' && <BasisBadge basis={o.pallets.basis} estimate={o.pallets.estimate} short />}
        </span>
      ),
    },
    {
      id: 'shipDate',
      label: 'Ship date',
      title: 'Wintec confirmed ship date, else the system schedule date',
      sortValue: (o) => o.shipDate,
      render: (o) => (
        <span className="whitespace-nowrap">
          {formatDate(o.shipDate)}
          {o.shipDateSource === 'scheduled' && <span title="No Wintec confirmed ship date; using the system schedule date" className="ml-1 text-xs text-slate-500">sched.</span>}
        </span>
      ),
    },
    { id: 'dockDate', label: 'Customer request', title: 'EMS Requested Dock Date', sortValue: (o) => o.dockDate, render: (o) => <span className="whitespace-nowrap">{formatDate(o.dockDate)}</span> },
    { id: 'originalRequest', label: 'Original request', title: "The report's Original Requested Date", sortValue: (o) => o.originalRequestDate, render: (o) => <span className="whitespace-nowrap">{formatDate(o.originalRequestDate)}</span>, defaultHidden: true },
    {
      id: 'gap',
      label: 'Ship vs request',
      title: 'Days the ship date falls after (+) or before (−) the customer requested dock date',
      align: 'right',
      sortValue: requestGap,
      render: (o) => {
        const gap = requestGap(o);
        if (gap === null) return '—';
        return <span className={gap > 0 ? 'font-medium text-red-700 dark:text-red-300' : 'text-slate-500'}>{gap > 0 ? `${gap}d after` : gap === 0 ? 'same day' : `${-gap}d before`}</span>;
      },
    },
    {
      id: 'change',
      label: 'Last change',
      title: 'Since the previous report',
      sortValue: (o) => shipDateShift(o.changes) ?? (o.changes.length ? 0 : null),
      render: (o) => {
        const c = leadChange(o.changes);
        if (!c) return <span className="text-slate-400">—</span>;
        const cause = describeCauses(c);
        return (
          <div className="min-w-48 text-xs">
            <span className="font-medium text-slate-900 dark:text-slate-100">{describeChange(c)}</span>
            {o.changes.length > 1 && <span className="text-slate-500"> +{o.changes.length - 1}</span>}
            {cause && <div className="text-slate-500">{cause}</div>}
          </div>
        );
      },
    },
  ];
  if (hasInventory) {
    cols.push({
      id: 'canShip',
      label: 'Can it ship?',
      sortValue: (o) => (o.supply ? READINESS.indexOf(o.supply.readiness) : null),
      render: (o) =>
        o.supply ? (
          <div className="min-w-40">
            <ReadinessBadge detail={o.supply} shipDate={o.shipDate} />
            <div className="mt-0.5 text-xs text-slate-500">{readinessReason(o.supply, o.shipDate)}</div>
          </div>
        ) : (
          '—'
        ),
    });
  }
  cols.push(
    { id: 'warehouse', label: 'Warehouse', sortValue: (o) => o.warehouse, render: (o) => o.warehouse ?? '—', className: 'whitespace-nowrap text-xs', defaultHidden: true },
    { id: 'group', label: 'Business group', sortValue: (o) => o.businessGroup, render: (o) => o.businessGroup ?? '—', className: 'text-xs', defaultHidden: true },
    { id: 'manufacturer', label: 'Manufacturer', sortValue: (o) => o.manufacturer, render: (o) => o.manufacturer ?? '—', className: 'text-xs', defaultHidden: true },
    { id: 'price', label: 'Total price', align: 'right', sortValue: (o) => o.totalPrice, render: (o) => o.totalPrice?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? '—', defaultHidden: true },
  );
  return cols;
}

function ShipToTable({ shipTos, showReadiness, onShowOrders }: { shipTos: OutboundShipTo[]; showReadiness: boolean; onShowOrders: (shipTo: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card className="overflow-x-auto p-0">
      <h2 className="px-4 pt-4 font-medium">By ship-to</h2>
      <p className="px-4 text-sm text-slate-500">
        Orders shipping in the selected range. Truckloads add up each order's share of a truck; trucks needed rounds up per ship-to and day. Click a ship-to for
        its parts.
      </p>
      <table className={tableCls}>
        <thead>
          <tr>
            <th className={thCls}>Ship to</th>
            {showReadiness && <th className={`${thCls} whitespace-nowrap`}>Can ship</th>}
            {['Orders', 'Units', 'Pallet-eq', 'Full + partial', 'Truckloads', 'Trucks needed', 'Estimated', 'Next ship date'].map((h) => (
              <th key={h} className={`${thCls} whitespace-nowrap text-right`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shipTos.map((s) => {
            const expanded = open === s.shipTo;
            const est = Math.round(estimatedShare(s.pallets) * 100);
            return (
              <Fragment key={s.shipTo}>
                <tr onClick={() => setOpen(expanded ? null : s.shipTo)} aria-expanded={expanded} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900">
                  <td className={`${tdCls} font-medium`}>
                    <span className="mr-1 inline-block w-3 text-slate-400">{expanded ? '▾' : '▸'}</span>
                    {s.shipTo}
                  </td>
                  {showReadiness && (
                    <td className={tdCls}>
                      <div className="flex items-center gap-2">
                        <ReadinessBar readiness={s.readiness} />
                        <span className="tabular-nums text-xs text-slate-500">{canShipShare(s) ?? '—'}%</span>
                      </div>
                    </td>
                  )}
                  <td className={right}>{s.orders}</td>
                  <td className={right}>{s.pallets.units.toLocaleString()}</td>
                  <td className={right}>{formatPallets(s.pallets.palletEq)}</td>
                  <td className={right}>{`${s.pallets.fullPallets} + ${s.pallets.partialPallets}`}</td>
                  <td className={right}>{formatPallets(s.trucks.truckloads)}</td>
                  <td className={`${right} font-medium`}>{s.trucks.trucksNeeded}</td>
                  <td className={`${right} ${est > 0 || s.pallets.noRatioLines > 0 ? 'text-amber-700 dark:text-amber-300' : ''}`}>
                    {est}%{s.pallets.noRatioLines > 0 && ` · ${s.pallets.noRatioUnits.toLocaleString()} units no ratio`}
                  </td>
                  <td className={`${right} whitespace-nowrap`}>{formatDate(s.nextShipDate)}</td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={showReadiness ? 10 : 9} className="border-b border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/50">
                      <PartsTable parts={s.parts} />
                      <button onClick={() => onShowOrders(s.shipTo)} className="mt-3 text-sm text-slate-600 hover:underline dark:text-slate-300">
                        Show its {plural(s.orders, 'order')} →
                      </button>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function PartsTable({ parts }: { parts: OutboundPart[] }) {
  return (
    <div className="overflow-x-auto">
      <h3 className="mb-1 text-sm font-medium">By part (MPN)</h3>
      <table className={tableCls}>
        <thead>
          <tr>
            {['MPN', 'CPN', 'Item', 'Group'].map((h) => <th key={h} className={thCls}>{h}</th>)}
            {['Orders', 'Units', 'Units / pallet', 'Pallet-eq', 'Full + partial'].map((h) => (
              <th key={h} className={`${thCls} whitespace-nowrap text-right`}>{h}</th>
            ))}
            <th className={thCls}>Units by status</th>
            <th className={`${thCls} whitespace-nowrap`}>Next ship</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((p) => (
            <tr key={`${p.mpn}|${p.cpn}`}>
              <td className={`${tdCls} whitespace-nowrap font-mono text-xs`}>{p.mpn ?? '—'}</td>
              <td className={`${tdCls} whitespace-nowrap font-mono text-xs`}>{p.cpn ?? '—'}</td>
              <td className={`${tdCls} max-w-xs truncate text-xs`} title={p.itemName ?? undefined}>{p.itemName ?? '—'}</td>
              <td className={`${tdCls} text-xs`}>{p.businessGroup ?? '—'}</td>
              <td className={right}>{p.orders}</td>
              <td className={right}>{p.pallets.units.toLocaleString()}</td>
              <td className={`${right} whitespace-nowrap`}>
                <BasisBadge basis={p.basis} estimate={p.estimate} short />
                {p.unitsPerPallet != null && <span className="ml-2">{p.unitsPerPallet.toLocaleString()}</span>}
              </td>
              <td className={right}>{p.basis === 'none' ? '—' : formatPallets(p.pallets.palletEq)}</td>
              <td className={right}>{p.basis === 'none' ? '—' : `${p.pallets.fullPallets} + ${p.pallets.partialPallets}`}</td>
              <td className={`${tdCls} text-xs`}>
                {Object.entries(p.unitsByStatus).map(([s, units]) => (
                  <div key={s} className="whitespace-nowrap">
                    <OrderStatus status={s} /> <span className="tabular-nums">{units.toLocaleString()}</span>
                  </div>
                ))}
              </td>
              <td className={`${tdCls} whitespace-nowrap`}>{formatDate(p.nextShipDate, { year: undefined })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
