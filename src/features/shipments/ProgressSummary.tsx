import { useQuery } from '@tanstack/react-query';
import { PROGRESS_BUCKETS, PROGRESS_BUCKET_LABELS, type ProgressBucket } from '../../../shared/progress';
import type { ProgressSummary as Summary } from '../../../shared/types';
import { Card } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { formatDate } from '../../lib/format';

export function useLatestProgress(branch: string) {
  return useQuery({
    queryKey: ['progress-latest', branch],
    queryFn: () => api<Summary | null>(`/progress/latest${qs({ branch: branch || undefined })}`),
  });
}

/** "Since the Oct 18 report: 43 shipped, 41 arrived, …" with each count acting as a filter. */
export function ProgressSummaryCard({
  summary,
  selected,
  onSelect,
}: {
  summary: Summary;
  selected: ProgressBucket | 'changed' | null;
  onSelect: (bucket: ProgressBucket | 'changed' | null) => void;
}) {
  const first = !summary.previousReportDate;
  const tile = (key: ProgressBucket, n: number) => {
    const active = selected === key;
    return (
      <button
        key={key}
        onClick={() => onSelect(active ? null : key)}
        disabled={n === 0}
        aria-pressed={active}
        className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-default disabled:opacity-50 ${
          active
            ? 'border-violet-400 bg-violet-50 dark:border-violet-700 dark:bg-violet-950/60'
            : 'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900'
        }`}
      >
        <div className="text-xl font-semibold tabular-nums">{n.toLocaleString()}</div>
        <div className="text-xs text-slate-500">{PROGRESS_BUCKET_LABELS[key]}</div>
      </button>
    );
  };
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">
          {first
            ? `First upload: ${formatDate(summary.reportDate)} report`
            : `Since the ${formatDate(summary.previousReportDate)} report`}
          <span className="font-normal text-slate-500"> · latest upload {formatDate(summary.reportDate)}</span>
        </h2>
        <button
          onClick={() => onSelect(selected === 'changed' ? null : 'changed')}
          aria-pressed={selected === 'changed'}
          className={`text-sm underline-offset-2 hover:underline ${selected === 'changed' ? 'font-medium text-violet-700 dark:text-violet-300' : 'text-slate-500'}`}
        >
          {selected === 'changed' ? 'Showing all changed lines' : 'Show all changed lines'}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {PROGRESS_BUCKETS.map((b) => tile(b, summary.counts[b]))}
      </div>
      {!first && summary.removedAwaiting ? (
        <p className="mt-2 text-xs text-slate-500">
          {summary.removedAwaiting.toLocaleString()} unshipped lines were no longer in the report and were removed (shipped under an ASN, or cancelled).
        </p>
      ) : null}
    </Card>
  );
}
