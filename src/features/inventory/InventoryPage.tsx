import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { READINESS, READINESS_LABELS } from '../../../shared/supply';
import type { SupplyPartRow, SupplyResponse } from '../../../shared/types';
import { useBranch } from '../../app/branch';
import { DataTable, type Column } from '../../components/DataTable';
import { ReadinessBadge, readinessReason } from '../../components/readiness';
import { Card, Empty, ErrorNote, PageHeader, StatTile, StatusBadge, tableCls, tdCls, thCls } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { formatDate, poLineLabel } from '../../lib/format';

const FILTERS = {
  'at-risk': { label: 'At risk', test: (p: SupplyPartRow) => p.readiness === 'late' || p.readiness === 'short' },
  short: { label: 'Short', test: (p: SupplyPartRow) => p.shortUnits > 0 },
  demand: { label: 'With open orders', test: (p: SupplyPartRow) => p.orders > 0 },
  changed: { label: 'Stock changed', test: (p: SupplyPartRow) => !!p.availableChange },
  all: { label: 'All parts', test: () => true },
} as const;
type Filter = keyof typeof FILTERS;
const isFilter = (v: string | null): v is Filter => !!v && v in FILTERS;

const right = `${tdCls} text-right tabular-nums`;
const n = (v: number) => (v ? v.toLocaleString() : '—');
const partKey = (p: SupplyPartRow) => `${p.partNumber}|${p.site}`;

const COLUMNS: Column<SupplyPartRow>[] = [
  {
    id: 'part',
    label: 'Part',
    sortValue: (p) => p.partNumber,
    render: (p) => (
      <>
        <span className="font-mono text-xs">{p.partNumber}</span>
        <div className="max-w-xs truncate text-xs text-slate-500" title={p.description ?? undefined}>
          {[p.mpn, p.description].filter(Boolean).join(' · ')}
        </div>
      </>
    ),
  },
  { id: 'site', label: 'Site', sortValue: (p) => p.site, render: (p) => p.site || '—', className: 'text-xs' },
  { id: 'commodity', label: 'Commodity', sortValue: (p) => p.commodity, render: (p) => p.commodity ?? '—', className: 'text-xs', defaultHidden: true },
  { id: 'available', label: 'Available', align: 'right', sortValue: (p) => p.available, render: (p) => n(p.available) },
  {
    id: 'availableChange',
    label: 'Δ available',
    title: 'Since the previous inventory report',
    align: 'right',
    sortValue: (p) => p.availableChange,
    render: (p) =>
      p.availableChange ? (
        <span className={p.availableChange < 0 ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}>
          {p.availableChange > 0 ? '+' : ''}
          {p.availableChange.toLocaleString()}
        </span>
      ) : (
        '—'
      ),
  },
  { id: 'held', label: 'Held', align: 'right', sortValue: (p) => p.held, render: (p) => n(p.held) },
  { id: 'onhand', label: 'On hand', align: 'right', sortValue: (p) => p.onhand, render: (p) => n(p.onhand), defaultHidden: true },
  { id: 'onReceipt', label: 'On receipt', align: 'right', sortValue: (p) => p.onReceipt, render: (p) => n(p.onReceipt) },
  { id: 'physical', label: 'Reserved in stock', align: 'right', sortValue: (p) => p.demand.physical, render: (p) => n(p.demand.physical) },
  { id: 'ordered', label: 'Reserved inbound', align: 'right', sortValue: (p) => p.demand.ordered, render: (p) => n(p.demand.ordered) },
  { id: 'onOrder', label: 'On order', align: 'right', sortValue: (p) => p.demand.onOrder, render: (p) => n(p.demand.onOrder) },
  {
    id: 'short',
    label: 'Short',
    align: 'right',
    sortValue: (p) => p.shortUnits,
    render: (p) => <span className={p.shortUnits ? 'font-medium text-red-700 dark:text-red-300' : ''}>{n(p.shortUnits)}</span>,
  },
  { id: 'firstShort', label: 'First short', sortValue: (p) => p.firstShortDate, render: (p) => <span className="whitespace-nowrap">{formatDate(p.firstShortDate, { year: undefined })}</span> },
  { id: 'nextInbound', label: 'Next inbound', sortValue: (p) => p.nextInboundEta, render: (p) => <span className="whitespace-nowrap">{formatDate(p.nextInboundEta, { year: undefined })}</span> },
  {
    id: 'status',
    label: 'Status',
    sortValue: (p) => (p.readiness ? READINESS.indexOf(p.readiness) : null),
    render: (p) =>
      p.readiness ? (
        <ReadinessBadge detail={{ readiness: p.readiness, coveredBy: null, supplierShipDate: null, shortUnits: p.shortUnits }} shipDate={null} />
      ) : (
        <span className="text-xs text-slate-500">No open orders</span>
      ),
  },
];

export function InventoryPage() {
  const { branch } = useBranch();
  const [params, setParams] = useSearchParams();
  const filter: Filter = isFilter(params.get('filter')) ? (params.get('filter') as Filter) : 'demand';
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, isLoading } = useQuery({
    queryKey: ['supply', branch],
    queryFn: () => api<SupplyResponse>(`/reports/supply${qs({ branch: branch || undefined })}`),
  });
  const parts = data?.parts ?? [];
  const q = search.trim().toLowerCase();
  const shown = parts
    .filter(FILTERS[filter].test)
    .filter((p) => !q || [p.partNumber, p.mpn, p.description].some((v) => v?.toLowerCase().includes(q)));
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, parts.filter(f.test).length])) as Record<Filter, number>;
  const withDemand = parts.filter((p) => p.orders > 0);
  const held = parts.reduce((s, p) => s + p.held, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={branch ? `Inventory · ${branch}` : 'Inventory'}
        description="Stock from the report's Inventory Summary tab, checked against open sales orders at the same warehouse. Available stock is free to reserve; on receipt is still open with suppliers."
      />
      {error && <ErrorNote error={error} />}

      {data && !data.inventory ? (
        <Empty>
          No inventory yet. <Link to="/import" className="underline">Import a report</Link> that has the Inventory Summary tab.
        </Empty>
      ) : (
        <>
          {data?.inventory && (
            <p className="text-sm text-slate-500">
              As of the {formatDate(data.inventory.reportDate)} inventory · orders from the {formatDate(data.outboundReportDate)} report
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Parts with open orders" value={withDemand.length} />
            <StatTile label="Short parts" value={counts.short} warn={counts.short > 0} hint={`${parts.reduce((s, p) => s + p.shortUnits, 0).toLocaleString()} units need a new buy`} />
            <StatTile label="Parts with late inbound" value={parts.filter((p) => p.lateUnits > 0).length} warn={parts.some((p) => p.lateUnits > 0)} hint="Inbound arrives after the order's ship date" />
            <StatTile label="Held units" value={held.toLocaleString()} hint="Quarantine, RMA and cycle-count branches; not available" />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(FILTERS) as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setParams(f === 'demand' ? {} : { filter: f }, { replace: true })}
                aria-pressed={filter === f}
                className={`rounded-full border px-3 py-1 text-sm ${filter === f ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900' : 'border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'}`}
              >
                {FILTERS[f].label} <span className="tabular-nums opacity-70">{counts[f]}</span>
              </button>
            ))}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search part, MPN or description"
              className="ml-auto w-64 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
          </div>

          <Card className="p-0">
            {isLoading ? (
              <div className="m-4 h-40 animate-pulse rounded-md bg-slate-100 dark:bg-slate-900" />
            ) : (
              <DataTable
                id="inventory-parts"
                rows={shown}
                columns={COLUMNS}
                rowKey={partKey}
                onRowClick={(p) => setOpen(open === partKey(p) ? null : partKey(p))}
                highlight={(p) => !!p.availableChange}
                renderExpanded={(p) => (open === partKey(p) ? <PartDetail part={p} /> : null)}
                empty="No parts match."
              />
            )}
            <p className="px-4 py-2 text-xs text-slate-500">
              Click a part for its orders and inbound PO lines.
              {parts.some((p) => p.availableChange !== null) && ' Tinted rows: available stock changed since the previous inventory report.'}
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function PartDetail({ part }: { part: SupplyPartRow }) {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <div className="overflow-x-auto">
        <h3 className="mb-1 text-sm font-medium">Open orders, in the order supply is matched</h3>
        {part.orderRows.length === 0 ? (
          <p className="text-sm text-slate-500">None.</p>
        ) : (
          <table className={tableCls}>
            <thead>
              <tr>{['Ship date', 'SO#', 'Ship to', 'Reservation', 'Qty', 'Can it ship?'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {part.orderRows.map((o) => (
                <tr key={o.id}>
                  <td className={`${tdCls} whitespace-nowrap`}>{formatDate(o.shipDate)}</td>
                  <td className={`${tdCls} font-mono text-xs`}>{o.soNumber}</td>
                  <td className={`${tdCls} text-xs`}>{o.shipTo ?? '—'}</td>
                  <td className={`${tdCls} text-xs`}>{o.status ?? '—'}</td>
                  <td className={right}>{o.quantity.toLocaleString()}</td>
                  <td className={tdCls}>
                    <ReadinessBadge detail={o} shipDate={o.shipDate} />
                    <div className="mt-0.5 text-xs text-slate-500">{readinessReason(o, o.shipDate)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="overflow-x-auto">
        <h3 className="mb-1 text-sm font-medium">Inbound PO lines, earliest first</h3>
        {part.inbound.length === 0 ? (
          <p className="text-sm text-slate-500">
            No open PO lines{part.onReceipt > 0 && `, though the inventory shows ${part.onReceipt.toLocaleString()} on receipt`}.
          </p>
        ) : (
          <table className={tableCls}>
            <thead>
              <tr>{['ETA', 'Supplier', 'PO / line', 'Branch', 'Qty', 'Status'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {part.inbound.map((s) => (
                <tr key={s.id}>
                  <td className={`${tdCls} whitespace-nowrap`}>{s.eta ? formatDate(s.eta) : <span className="text-amber-700 dark:text-amber-300">No ETA</span>}</td>
                  <td className={tdCls}>{s.supplier}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>{poLineLabel(s)}</td>
                  <td className={`${tdCls} text-xs`}>{s.branch ?? '—'}</td>
                  <td className={right}>{s.quantity?.toLocaleString() ?? '—'}</td>
                  <td className={tdCls}><StatusBadge status={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {part.readiness && (
        <p className="text-xs text-slate-500 xl:col-span-2">
          Orders reserved in stock are ready. Orders reserved against inbound take PO lines earliest ETA first; on-order demand takes free stock, then the inbound left,
          and anything else is short. Status shows the worst order: {READINESS_LABELS[part.readiness].toLowerCase()}.
        </p>
      )}
    </div>
  );
}
