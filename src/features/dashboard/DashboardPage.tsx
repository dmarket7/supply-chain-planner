import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { daysBetween, todayIso } from '../../../shared/dates';
import type { DashboardBucket, DashboardResponse, DashboardTop, SupplyOrderRow } from '../../../shared/types';
import { Card, ErrorNote, PageHeader, StatTile, tableCls, tdCls, thCls } from '../../components/ui';
import { READINESS_GROUPS, ReadinessBadge, readinessReason } from '../../components/readiness';
import { useBranch } from '../../app/branch';
import { api, qs } from '../../lib/api';
import { formatDate, formatPallets, poLineLabel } from '../../lib/format';
import { bucketLabel, FlowChart } from './FlowChart';

const short = (iso: string | null) => formatDate(iso, { year: undefined });

/** "Data as of" for each tab; the dates should match when the same report was imported. */
function AsOf({ asOf }: { asOf: DashboardResponse['asOf'] }) {
  const dates = [
    ['POs', asOf.purchaseOrders],
    ['Orders', asOf.outbound],
    ['Inventory', asOf.inventory],
  ] as const;
  const known = dates.map(([, d]) => d).filter(Boolean);
  const mismatch = new Set(known).size > 1;
  return (
    <p className={`text-sm ${mismatch ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500'}`}>
      Data as of: {dates.map(([label, d]) => `${label} ${d ? formatDate(d) : 'not imported'}`).join(' · ')}
      {mismatch && ' — these come from different reports. '}
      {(mismatch || known.length < 3) && <Link to="/import" className="underline">Import the latest report</Link>}
    </p>
  );
}

function TopList({ title, items, unit }: { title: string; items: DashboardTop[]; unit: string }) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing in this period.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.map((t) => (
            <li key={t.name} className="flex gap-3">
              <span className="truncate">{t.name}</span>
              <span className="ml-auto whitespace-nowrap tabular-nums text-slate-500">
                {t.palletEq > 0 ? `${formatPallets(t.palletEq)} pallets` : `${t.units.toLocaleString()} units`} · {t.count} {unit}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BucketDetail({ bucket, onClose }: { bucket: DashboardBucket; onClose: () => void }) {
  const range = bucket.from ? qs({ from: bucket.from, to: bucket.to }) : '';
  return (
    <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="font-medium">{bucketLabel(bucket)}</h2>
        <span className="text-sm text-slate-500">
          {formatPallets(bucket.inbound.pallets.palletEq)} pallets in · {formatPallets(bucket.outbound.pallets.palletEq)} pallets and{' '}
          {bucket.outbound.trucks.trucksNeeded} trucks out
        </span>
        <button onClick={onClose} className="ml-auto text-sm text-slate-500 hover:underline">Close</button>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <TopList title="Arriving from" items={bucket.inbound.topSuppliers} unit="lines" />
          <Link to={`/inbound${range}`} className="mt-2 inline-block text-sm underline">Inbound by day →</Link>
        </div>
        <div>
          <TopList title="Shipping to" items={bucket.outbound.topShipTos} unit="orders" />
          <Link to={`/outbound${range}`} className="mt-2 inline-block text-sm underline">Outbound by site →</Link>
        </div>
      </div>
    </div>
  );
}

/** One "where we're stuck" row: a headline count, opened on demand. */
function Issue({ title, count, summary, link, children }: { title: string; count: number; summary: ReactNode; link: { to: string; label: string }; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-slate-200 last:border-b-0 dark:border-slate-800">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 text-left">
        <span className={`w-14 text-lg font-semibold tabular-nums ${count ? '' : 'text-slate-400'}`}>{count.toLocaleString()}</span>
        <span className="font-medium">{title}</span>
        <span className="text-sm text-slate-500">{summary}</span>
        <span className="ml-auto text-sm text-slate-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="overflow-x-auto px-4 pb-4">
          {children}
          <Link to={link.to} className="mt-2 inline-block text-sm underline">{link.label} →</Link>
        </div>
      )}
    </div>
  );
}

function OrderRows({ rows }: { rows: SupplyOrderRow[] }) {
  if (!rows.length) return <p className="text-sm text-slate-500">None.</p>;
  return (
    <table className={tableCls}>
      <thead>
        <tr>{['Ship date', 'SO#', 'Ship to', 'Part', 'Qty', 'Can it ship?'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((o) => (
          <tr key={o.id}>
            <td className={`${tdCls} whitespace-nowrap`}>{formatDate(o.shipDate)}</td>
            <td className={`${tdCls} font-mono text-xs`}>{o.soNumber}</td>
            <td className={tdCls}>{o.shipTo ?? '—'}</td>
            <td className={`${tdCls} text-xs`}>{o.cpn ?? '—'}{o.mpn && <div className="text-slate-500">{o.mpn}</div>}</td>
            <td className={`${tdCls} tabular-nums`}>{o.quantity.toLocaleString()}</td>
            <td className={tdCls}>
              <ReadinessBadge detail={o} shipDate={o.shipDate} />
              {o.readiness && <div className="mt-0.5 text-xs text-slate-500">{readinessReason(o, o.shipDate)}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DashboardPage() {
  const { branch } = useBranch();
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, isLoading } = useQuery({
    queryKey: ['dashboard', branch],
    queryFn: () => api<DashboardResponse>(`/reports/dashboard${qs({ branch: branch || undefined })}`),
  });
  const today = todayIso();
  const week = data?.buckets.find((b) => b.key === 'week-0');
  const ex = data?.exceptions;
  const hasInventory = !!data?.asOf.inventory;
  const weekUnits = week ? Object.values(week.outbound.readiness).reduce((n, r) => n + (r?.units ?? 0), 0) : 0;
  const canShipUnits = week ? READINESS_GROUPS[0].members.reduce((n, r) => n + (week.outbound.readiness[r]?.units ?? 0), 0) : 0;
  const readyPct = weekUnits ? Math.round((canShipUnits / weekUnits) * 100) : null;
  const selectedBucket = data?.buckets.find((b) => b.key === selected);
  const gaps = ex?.dataGaps;
  const estPct = gaps?.palletEq ? Math.round((gaps.estimatedPalletEq / gaps.palletEq) * 100) : 0;

  return (
    <div className="space-y-6">
      <PageHeader title={branch ? `Dashboard · ${branch}` : 'Dashboard'} description="What's arriving and what has to ship, by week, and where things are stuck." />
      {error && <ErrorNote error={error} />}
      {data && <AsOf asOf={data.asOf} />}

      <Card>
        {isLoading || !data ? (
          <div className="h-80 animate-pulse rounded-md bg-slate-100 dark:bg-slate-900" />
        ) : (
          <>
            <FlowChart buckets={data.buckets} selected={selected} onSelect={(k) => setSelected(k === selected ? null : k)} />
            {selectedBucket && <BucketDetail bucket={selectedBucket} onClose={() => setSelected(null)} />}
          </>
        )}
      </Card>

      {week && ex && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Inbound, next 7 days" value={`${formatPallets(week.inbound.pallets.palletEq)} pal`} hint={`${week.inbound.lines.toLocaleString()} PO lines`} />
          <StatTile
            label="Outbound, next 7 days"
            value={`${formatPallets(week.outbound.pallets.palletEq)} pal`}
            hint={`${week.outbound.trucks.trucksNeeded} trucks · ${week.outbound.orders.toLocaleString()} orders`}
          />
          <StatTile
            label="Can ship, next 7 days"
            value={readyPct === null ? '—' : `${readyPct}%`}
            warn={readyPct !== null && readyPct < 80}
            hint={hasInventory ? 'of units: in stock or reserved' : 'Import an Inventory Summary to check stock'}
          />
          <StatTile
            label="Short parts"
            value={hasInventory ? ex.shortParts.count : '—'}
            warn={ex.shortParts.count > 0}
            hint={hasInventory ? `${ex.shortParts.units.toLocaleString()} units with no stock or inbound` : 'Needs an Inventory Summary'}
          />
        </div>
      )}

      {ex && gaps && (
        <Card className="p-0">
          <h2 className="px-4 pt-4 font-medium">Where we're stuck</h2>
          <p className="px-4 pb-2 text-sm text-slate-500">Open a row to see the worst cases.</p>
          <Issue
            title="Outbound at risk"
            count={ex.atRisk.count}
            summary={`Late or short, shipping in the next 14 days or already due · ${ex.atRisk.units.toLocaleString()} units`}
            link={{ to: '/outbound?readiness=late,short', label: 'All at-risk orders' }}
          >
            <OrderRows rows={ex.atRisk.rows} />
          </Issue>
          <Issue
            title="Overdue outbound"
            count={ex.overdue.count}
            summary={
              hasInventory
                ? `Ship date before the ${short(data!.asOf.outbound)} report · ${ex.overdue.byReadiness.ready ?? 0} with stock reserved (shipping or ops), ${ex.overdue.count - (ex.overdue.byReadiness.ready ?? 0) - (ex.overdue.byReadiness.stock ?? 0)} waiting on supply`
                : 'Ship date before the report date, still open'
            }
            link={{ to: '/outbound', label: 'Outbound' }}
          >
            <OrderRows rows={ex.overdue.rows} />
          </Issue>
          <Issue title="Late inbound" count={ex.lateInbound.count} summary="Expected date passed, not arrived" link={{ to: '/shipments', label: 'Shipments' }}>
            {ex.lateInbound.rows.length ? (
              <table className={tableCls}>
                <thead>
                  <tr>{['Expected', 'Days late', 'Supplier', 'PO / line', 'Part', 'Qty'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {ex.lateInbound.rows.map((r) => (
                    <tr key={r.id}>
                      <td className={`${tdCls} whitespace-nowrap`}>{formatDate(r.eta)}</td>
                      <td className={`${tdCls} tabular-nums`}>{daysBetween(r.eta, today)}</td>
                      <td className={tdCls}>{r.supplier}</td>
                      <td className={`${tdCls} whitespace-nowrap`}>{poLineLabel(r)}</td>
                      <td className={`${tdCls} text-xs`}>{r.partNumber ?? '—'}</td>
                      <td className={`${tdCls} tabular-nums`}>{r.quantity?.toLocaleString() ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-slate-500">None.</p>
            )}
          </Issue>
          <Issue
            title="Short parts"
            count={ex.shortParts.count}
            summary={hasInventory ? 'Open orders that no stock or inbound PO covers: a new buy is needed' : 'Import an Inventory Summary to check stock'}
            link={{ to: '/inventory?filter=short', label: 'All short parts' }}
          >
            {ex.shortParts.rows.length ? (
              <table className={tableCls}>
                <thead>
                  <tr>{['Part', 'Site', 'Short units', 'First short ship date', 'Orders'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {ex.shortParts.rows.map((p) => (
                    <tr key={`${p.partNumber}-${p.site}`}>
                      <td className={tdCls}>{p.partNumber}{p.description && <div className="text-xs text-slate-500">{p.description}</div>}</td>
                      <td className={tdCls}>{p.site}</td>
                      <td className={`${tdCls} tabular-nums`}>{p.shortUnits.toLocaleString()}</td>
                      <td className={`${tdCls} whitespace-nowrap`}>{formatDate(p.firstShortDate)}</td>
                      <td className={`${tdCls} tabular-nums`}>{p.orders}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-slate-500">None.</p>
            )}
          </Issue>
          <Issue
            title="Data gaps"
            count={gaps.noEtaOrders + gaps.noRatioLines}
            summary={`${gaps.noEtaOrders.toLocaleString()} orders waiting on inbound with no ETA · ${estPct}% of pallets estimated · ${gaps.noRatioLines} lines with no pallet ratio`}
            link={{ to: '/settings/pallets?filter=needs-data', label: 'Improve pallet ratios' }}
          >
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>
                <strong>{gaps.noEtaOrders.toLocaleString()}</strong> orders ({gaps.noEtaUnits.toLocaleString()} units) rely on supplier POs with no ETA yet, so
                we can't tell if they'll make their ship date. <Link to="/outbound?readiness=noEta" className="underline">See them</Link>, and ask suppliers for ETAs.
              </li>
              <li>
                <strong>{estPct}%</strong> of the pallets on this page are estimated from commodity averages, and {gaps.noRatioLines} lines (
                {gaps.noRatioUnits.toLocaleString()} units) have no ratio at all.
              </li>
            </ul>
          </Issue>
        </Card>
      )}
    </div>
  );
}
