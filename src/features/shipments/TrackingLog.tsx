import type { TrackingRun } from '../../../shared/types';
import { Empty, ErrorNote, tableCls, tdCls, thCls } from '../../components/ui';
import { formatDateTime, relativeTime } from '../../lib/format';
import { useTrackingRuns } from './TrackingRefresh';

const SCOPE_LABELS: Record<string, string> = {
  open: 'Refresh tracking',
  estimated: 'Confirm estimated arrivals',
  line: 'Single shipment',
};

function outcome(r: TrackingRun): { text: string; cls: string } {
  if (r.error) return { text: `Failed: ${r.error}`, cls: 'text-red-700 dark:text-red-300' };
  if (r.rateLimited) return { text: 'Paused (rate limit)', cls: 'text-amber-700 dark:text-amber-300' };
  if (r.remaining > 0) return { text: `Stopped, ${r.remaining.toLocaleString()} left`, cls: 'text-slate-500' };
  if (r.checked === 0) return { text: 'Nothing due', cls: 'text-slate-500' };
  return { text: 'Complete', cls: 'text-slate-600 dark:text-slate-300' };
}

/** History of tracking refreshes. Clicking a run filters the table to lines it changed. */
export function TrackingLog({ selectedRunId, onSelectRun }: { selectedRunId: number | null; onSelectRun: (id: number | null) => void }) {
  const { data, error } = useTrackingRuns();
  const runs = data ?? [];
  return (
    <details className="group rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium">
        Refresh history
        {runs[0] && (
          <span className="ml-2 font-normal text-slate-500">
            · last run {relativeTime(runs[0].startedAt)}: {runs[0].linesChanged.toLocaleString()} lines changed
          </span>
        )}
      </summary>
      <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
        {error ? (
          <div className="p-4"><ErrorNote error={error} /></div>
        ) : runs.length === 0 ? (
          <div className="p-4"><Empty>No tracking refreshes yet.</Empty></div>
        ) : (
          <table className={tableCls}>
            <thead>
              <tr>
                {['Started', 'By', 'Type', 'Branch', 'Checked', 'Found', 'Not found', 'Lines changed', 'Arrivals confirmed', 'Result'].map((h) => (
                  <th key={h} className={`${thCls} whitespace-nowrap`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const o = outcome(r);
                const selected = r.id === selectedRunId;
                return (
                  <tr
                    key={r.id}
                    onClick={() => onSelectRun(selected ? null : r.id)}
                    title={r.linesChanged ? 'Show the lines this run changed' : undefined}
                    className={`cursor-pointer ${selected ? 'bg-violet-50 dark:bg-violet-950/40' : 'hover:bg-slate-50 dark:hover:bg-slate-900'}`}
                  >
                    <td className={`${tdCls} whitespace-nowrap`} title={formatDateTime(r.startedAt)}>{relativeTime(r.startedAt)}</td>
                    <td className={`${tdCls} text-xs`}>{r.startedBy}</td>
                    <td className={`${tdCls} whitespace-nowrap`}>{SCOPE_LABELS[r.scope] ?? r.scope}</td>
                    <td className={`${tdCls} whitespace-nowrap text-xs`}>{r.branch ?? 'All'}</td>
                    <td className={`${tdCls} tabular-nums`}>{r.checked.toLocaleString()}</td>
                    <td className={`${tdCls} tabular-nums`}>{r.found.toLocaleString()}</td>
                    <td className={`${tdCls} tabular-nums`}>{r.notFound.toLocaleString()}</td>
                    <td className={`${tdCls} tabular-nums font-medium`}>{r.linesChanged.toLocaleString()}</td>
                    <td className={`${tdCls} tabular-nums`}>{r.arrivalsConfirmed.toLocaleString()}</td>
                    <td className={`${tdCls} text-xs ${o.cls}`}>{o.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="px-4 py-2 text-xs text-slate-500">
          "Lines changed" counts lines whose status, ETA, arrival or scans changed. Click a run to list the lines it last changed.
        </p>
      </div>
    </details>
  );
}
