import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { addDays, todayIso } from '../../../shared/dates';
import type { ImportHistoryRow } from '../../../shared/types';
import { Card, ErrorNote, tableCls, tdCls, thCls } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';

/** A count, linked to the filtered view when it describes the current data. */
function Count({ n, label, to }: { n: number | null | undefined; label: string; to?: string }) {
  if (!n) return null;
  const text = (
    <>
      <span className="font-medium tabular-nums">{n.toLocaleString()}</span> {label}
    </>
  );
  return <span className="whitespace-nowrap">{to ? <Link to={to} className="hover:underline">{text}</Link> : text}</span>;
}

function Cell({ children, empty }: { children: ReactNode[]; empty: string }) {
  const items = children.filter(Boolean);
  return (
    <td className={`${tdCls} text-sm`}>
      {items.length ? <div className="flex flex-wrap gap-x-3 gap-y-1">{items}</div> : <span className="text-slate-400">{empty}</span>}
    </td>
  );
}

/**
 * What each imported report changed, tab by tab. The newest report's counts link to the views
 * filtered to those lines; older ones are for reference, since the views show the current data.
 */
export function ImportHistory() {
  const { data, error } = useQuery({ queryKey: ['import-history'], queryFn: () => api<ImportHistoryRow[]>('/imports/history') });
  if (error) return <ErrorNote error={error} />;
  if (!data?.length) return null;
  const today = todayIso();
  const outboundRange = `from=${addDays(today, -30)}&to=${addDays(today, 180)}`;
  const latestInbound = data.find((r) => r.inbound)?.reportDate;
  const latestOutbound = data.find((r) => r.outbound)?.reportDate;
  const latestInventory = data.find((r) => r.inventory)?.reportDate;

  return (
    <Card className="overflow-x-auto p-0">
      <h2 className="px-4 pt-4 font-medium">Import history</h2>
      <p className="px-4 text-sm text-slate-500">What each report changed compared with the one before it. The newest counts open the matching lines.</p>
      <table className={tableCls}>
        <thead>
          <tr>
            {['Report', 'Inbound PO lines', 'Outbound orders', 'Inventory'].map((h) => <th key={h} className={`${thCls} whitespace-nowrap`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((r) => {
            const inLink = r.reportDate === latestInbound;
            const outLink = r.reportDate === latestOutbound;
            const invLink = r.reportDate === latestInventory;
            const o = r.outbound?.summary;
            const c = r.inbound?.counts;
            return (
              <tr key={r.reportDate}>
                <td className={`${tdCls} whitespace-nowrap font-medium`}>{formatDate(r.reportDate)}</td>
                {r.inbound ? (
                  <Cell empty="No changes">
                    {[
                      <Count key="s" n={c?.shipped} label="shipped" to={inLink ? '/inbound?changed=shipped' : undefined} />,
                      <Count key="a" n={c?.arrived} label="arrived" to={inLink ? '/inbound?changed=arrived' : undefined} />,
                      <Count key="e" n={c?.eta_moved} label="ETA moved" to={inLink ? '/inbound?changed=eta_moved' : undefined} />,
                      <Count key="n" n={c?.new_order} label="new" to={inLink ? '/inbound?changed=new_order' : undefined} />,
                    ]}
                  </Cell>
                ) : (
                  <td className={`${tdCls} text-sm text-slate-400`}>Not imported</td>
                )}
                {r.outbound ? (
                  o ? (
                    <Cell empty="No changes">
                      {[
                        <Count key="p" n={o.pushedOut} label="pushed out" to={outLink ? `/outbound?changed=pushed&${outboundRange}` : undefined} />,
                        <Count key="i" n={o.pulledIn} label="pulled in" to={outLink ? `/outbound?changed=pulled&${outboundRange}` : undefined} />,
                        <Count key="d" n={o.dockMoved} label="customer moved dock" to={outLink ? `/outbound?changed=dock&${outboundRange}` : undefined} />,
                        <Count key="n" n={o.added} label="new" to={outLink ? `/outbound?changed=new&${outboundRange}` : undefined} />,
                        <Count key="g" n={o.gone} label="gone" />,
                        o.noCause > 0 && (
                          <span key="c" className="whitespace-nowrap text-slate-500">
                            {o.noCause.toLocaleString()} date moves with no cause
                          </span>
                        ),
                      ]}
                    </Cell>
                  ) : (
                    <td className={`${tdCls} text-sm text-slate-500`}>{r.outbound.orderCount.toLocaleString()} orders, first report</td>
                  )
                ) : (
                  <td className={`${tdCls} text-sm text-slate-400`}>Not imported</td>
                )}
                {r.inventory ? (
                  r.inventory.up === null ? (
                    <td className={`${tdCls} text-sm text-slate-500`}>{r.inventory.positionCount.toLocaleString()} positions, first report</td>
                  ) : (
                    <Cell empty="No stock moves">
                      {[
                        <Count key="u" n={r.inventory.up} label="parts up" to={invLink ? '/inventory?filter=changed' : undefined} />,
                        <Count key="d" n={r.inventory.down} label="parts down" to={invLink ? '/inventory?filter=changed' : undefined} />,
                      ]}
                    </Cell>
                  )
                ) : (
                  <td className={`${tdCls} text-sm text-slate-400`}>Not imported</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
