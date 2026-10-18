import { useBranch, useBranchSummaries } from '../../app/branch';
import { Card, tableCls, tdCls, thCls } from '../../components/ui';

/** Headline counts per branch, shown on the Inbound page when no branch is selected. */
export function BranchSummaryTable() {
  const { setBranch } = useBranch();
  const { data } = useBranchSummaries();
  if (!data || data.length < 2) return null;

  const num = (n: number, warn = false) => (
    <td className={`${tdCls} text-right tabular-nums ${warn && n > 0 ? 'text-red-700 dark:text-red-300' : ''}`}>
      {n.toLocaleString()}
    </td>
  );
  return (
    <Card className="overflow-x-auto p-0">
      <h2 className="px-4 pt-4 font-medium">By branch</h2>
      <p className="px-4 text-sm text-slate-500">Click a branch to filter every page to it.</p>
      <table className={tableCls}>
        <thead>
          <tr>
            <th className={thCls}>Branch</th>
            {['Due today', 'Next 7 days', 'Past due', 'Awaiting shipment', 'Arrived (30 days)'].map((h) => (
              <th key={h} className={`${thCls} text-right`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((b) => (
            <tr key={b.branch} onClick={() => setBranch(b.branch)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900">
              <td className={`${tdCls} whitespace-nowrap font-medium`}>{b.branch}</td>
              {num(b.dueToday)}
              {num(b.next7Days)}
              {num(b.pastDue, true)}
              {num(b.awaitingShipment)}
              {num(b.arrivedLast30Days)}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
