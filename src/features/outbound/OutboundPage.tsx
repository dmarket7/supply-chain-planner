import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { addDays, todayIso } from '../../../shared/dates';
import { estimatedShare, mergeSummaries, mergeTrucks } from '../../../shared/pallets';
import { READINESS, READINESS_LABELS, type Readiness } from '../../../shared/supply';
import type { OutboundOrder, OutboundPart, OutboundResponse, OutboundShipTo } from '../../../shared/types';
import { useBranch } from '../../app/branch';
import { DataQualityNote, MetricToggle, useStoredChoice } from '../../components/pallets';
import { READINESS_GROUPS, ReadinessBadge, ReadinessBar, readinessReason } from '../../components/readiness';
import { BasisBadge, Card, DateInput, Empty, ErrorNote, PageHeader, StatTile, tableCls, tdCls, thCls } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { formatDate, formatPallets } from '../../lib/format';
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

/** `?readiness=late,short` limits the order lists to those states. */
function parseReadiness(v: string | null): Readiness[] {
  return (v ?? '').split(',').filter((r): r is Readiness => (READINESS as readonly string[]).includes(r));
}
const READINESS_FILTERS = [
  { label: 'All orders', value: '' },
  { label: 'At risk', value: 'late,short' },
  { label: 'No ETA', value: 'noEta' },
  { label: 'Short', value: 'short' },
];
const canShipShare = (s: OutboundShipTo) => {
  const total = Object.values(s.readiness).reduce((n, r) => n + (r?.units ?? 0), 0);
  const ok = READINESS_GROUPS[0].members.reduce((n, r) => n + (s.readiness[r]?.units ?? 0), 0);
  return total ? Math.round((ok / total) * 100) : null;
};
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

export function OutboundPage() {
  const today = todayIso();
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState(params.get('from') ?? addDays(today, -7));
  const [to, setTo] = useState(params.get('to') ?? addDays(today, 28));
  const readiness = parseReadiness(params.get('readiness'));
  const setReadiness = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set('readiness', value);
    else next.delete('readiness');
    setParams(next, { replace: true });
  };
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
  const hasInventory = !!data?.inventoryReportDate;
  const matching = readiness.length
    ? shipTos.flatMap((s) => s.lines).filter((o) => o.supply && readiness.includes(o.supply.readiness)).sort((a, b) => a.shipDate!.localeCompare(b.shipDate!))
    : [];

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
              {snapshot.changes && (
                <>
                  {' '}· since {formatDate(snapshot.changes.previousReportDate)}: {plural(snapshot.changes.noLongerListed, 'SO')} no longer listed (shipped or cancelled),{' '}
                  {snapshot.changes.added.toLocaleString()} new, {snapshot.changes.quantityChanged.toLocaleString()} with a changed quantity
                </>
              )}
              {hasInventory ? ` · stock checked against the ${formatDate(data!.inventoryReportDate)} inventory` : ' · import a report with the Inventory Summary tab to check stock'}
            </p>
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
              <OutboundChart days={days} metric={metric} />
            )}
          </Card>

          {hasInventory && (
            <div role="group" aria-label="Show orders" className="flex flex-wrap gap-2">
              {READINESS_FILTERS.map((f) => {
                const active = readiness.join(',') === f.value;
                return (
                  <button
                    key={f.label}
                    onClick={() => setReadiness(f.value)}
                    aria-pressed={active}
                    className={`rounded-full border px-3 py-1 text-sm ${active ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900' : 'border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
          )}

          {readiness.length > 0 ? (
            <Card className="overflow-x-auto">
              <h2 className="font-medium">
                {matching.length.toLocaleString()} {readiness.map((r) => READINESS_LABELS[r].toLowerCase()).join(' or ')} orders in this range
              </h2>
              <OrdersTable orders={matching} showShipTo />
            </Card>
          ) : (
            shipTos.length > 0 && <ShipToTable shipTos={shipTos} showReadiness={hasInventory} />
          )}
        </>
      )}
    </div>
  );
}

function ShipToTable({ shipTos, showReadiness }: { shipTos: OutboundShipTo[]; showReadiness: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card className="overflow-x-auto p-0">
      <h2 className="px-4 pt-4 font-medium">By ship-to</h2>
      <p className="px-4 text-sm text-slate-500">
        Orders shipping in the selected range. Truckloads add up each order's share of a truck; trucks needed rounds up per ship-to and day. Click a ship-to for
        its parts and orders.
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
                      <OrdersTable orders={s.lines} />
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
                {Object.entries(p.unitsByStatus).map(([status, units]) => (
                  <div key={status} className="whitespace-nowrap">
                    <OrderStatus status={status} /> <span className="tabular-nums">{units.toLocaleString()}</span>
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

const SHOWN_ORDERS = 25;

function OrdersTable({ orders, showShipTo = false }: { orders: OutboundOrder[]; showShipTo?: boolean }) {
  const [all, setAll] = useState(false);
  const rows = all ? orders : orders.slice(0, SHOWN_ORDERS);
  return (
    <div className="mt-4 overflow-x-auto">
      <h3 className="mb-1 text-sm font-medium">Orders</h3>
      <table className={tableCls}>
        <thead>
          <tr>
            {[...(showShipTo ? ['Ship to'] : []), 'Wintec SO#', 'EMS PO#', 'Status', 'Ship date', 'Dock date', 'MPN'].map((h) => (
              <th key={h} className={`${thCls} whitespace-nowrap`}>{h}</th>
            ))}
            {['Qty', 'Pallets'].map((h) => <th key={h} className={`${thCls} text-right`}>{h}</th>)}
            {orders.some((o) => o.supply) && <th className={thCls}>Can it ship?</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              {showShipTo && <td className={tdCls}>{o.shipTo ?? '—'}</td>}
              <td className={`${tdCls} font-mono text-xs`}>{o.soNumber}</td>
              <td className={`${tdCls} font-mono text-xs`}>{o.emsPo ?? '—'}</td>
              <td className={tdCls}><OrderStatus status={o.status} /></td>
              <td className={`${tdCls} whitespace-nowrap`}>
                {formatDate(o.shipDate)}
                {o.shipDateSource === 'scheduled' && (
                  <span title="No Wintec confirmed ship date; using the system schedule date" className="ml-1 text-xs text-slate-500">sched.</span>
                )}
              </td>
              <td className={`${tdCls} whitespace-nowrap`}>{formatDate(o.dockDate)}</td>
              <td className={`${tdCls} font-mono text-xs`}>{o.mpn ?? '—'}</td>
              <td className={right}>{o.quantity.toLocaleString()}</td>
              <td className={`${right} whitespace-nowrap`}>
                {o.pallets.palletEq != null && <span className="mr-2">{formatPallets(o.pallets.palletEq)}</span>}
                {o.pallets.basis !== 'real' && <BasisBadge basis={o.pallets.basis} estimate={o.pallets.estimate} short />}
              </td>
              {o.supply && (
                <td className={tdCls}>
                  <ReadinessBadge detail={o.supply} shipDate={o.shipDate} />
                  <div className="mt-0.5 text-xs text-slate-500">{readinessReason(o.supply, o.shipDate)}</div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {orders.length > SHOWN_ORDERS && (
        <button onClick={() => setAll(!all)} className="mt-1 text-sm text-slate-500 hover:underline">
          {all ? 'Show fewer' : `Show all ${orders.length} orders`}
        </button>
      )}
    </div>
  );
}
