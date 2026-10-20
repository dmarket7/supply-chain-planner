import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBranch } from '../../app/branch';
import { ErrorNote } from '../../components/ui';
import { api } from '../../lib/api';
import type { TrackingRun } from '../../../shared/types';

type Scope = 'open' | 'estimated';

/** Recent refresh runs (newest first); the first one defines "changed in the latest refresh". */
export function useTrackingRuns() {
  return useQuery({ queryKey: ['tracking-runs'], queryFn: () => api<TrackingRun[]>('/tracking/runs?limit=20') });
}

interface RefreshResult {
  checked: number;
  found: number;
  linesUpdated: number;
  arrivalsConfirmed: number;
  remaining: number;
  rateLimited: boolean;
  retryAfterSeconds: number | null;
  ignoredDeliveries: number;
  notFound: number;
  linesChanged: number;
  runId: number;
}

interface Totals {
  scope: Scope;
  checked: number;
  found: number;
  linesUpdated: number;
  arrivalsConfirmed: number;
  ignoredDeliveries: number;
  notFound: number;
  linesChanged: number;
  remaining: number;
  rateLimited: boolean;
  stopped: boolean;
}

const SCOPE_LABELS: Record<Scope, string> = {
  open: 'Refresh tracking',
  estimated: 'Confirm estimated arrivals',
};

/**
 * Tracking refresh controls (buttons + status line). Runs batch by batch (the API does ~20 numbers per call) until nothing is left,
 * the provider rate-limits us, or the user stops it.
 */
export function useTrackingRefresh() {
  const queryClient = useQueryClient();
  const { branch } = useBranch();
  const status = useQuery({
    queryKey: ['tracking-status'],
    queryFn: () => api<{ configured: boolean; providers: string[] }>('/tracking/status'),
    staleTime: 5 * 60_000,
  });
  const [running, setRunning] = useState<Scope | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [error, setError] = useState<unknown>(null);
  const stop = useRef(false);

  async function run(scope: Scope) {
    stop.current = false;
    setRunning(scope);
    setError(null);
    let t: Totals = {
      scope,
      checked: 0,
      found: 0,
      linesUpdated: 0,
      arrivalsConfirmed: 0,
      ignoredDeliveries: 0,
      notFound: 0,
      linesChanged: 0,
      remaining: 0,
      rateLimited: false,
      stopped: false,
    };
    setTotals(t);
    let runId: number | undefined;
    try {
      for (;;) {
        const r: RefreshResult = await api<RefreshResult>('/tracking/refresh', {
          method: 'POST',
          body: JSON.stringify({ scope, branch: branch || null, runId }),
        });
        runId = r.runId;
        t = {
          ...t,
          checked: t.checked + r.checked,
          found: t.found + r.found,
          linesUpdated: t.linesUpdated + r.linesUpdated,
          arrivalsConfirmed: t.arrivalsConfirmed + r.arrivalsConfirmed,
          ignoredDeliveries: t.ignoredDeliveries + r.ignoredDeliveries,
          notFound: t.notFound + r.notFound,
          linesChanged: t.linesChanged + r.linesChanged,
          remaining: r.remaining,
          rateLimited: r.rateLimited,
          stopped: stop.current,
        };
        setTotals(t);
        void queryClient.invalidateQueries({ queryKey: ['tracking-runs'] });
        if (r.rateLimited || r.remaining === 0 || r.checked === 0 || stop.current) break;
      }
    } catch (e) {
      setError(e);
    } finally {
      setRunning(null);
      void queryClient.invalidateQueries();
    }
  }

  const configured = status.data?.configured;
  const btn = 'rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-700';
  return {
    // Nothing to show until a carrier API connection is configured on the server.
    configured: !!configured,
    buttons: !configured ? null : (
      <>
        {running ? (
          <button onClick={() => (stop.current = true)} className={btn}>
            Stop
          </button>
        ) : (
          <>
            <button onClick={() => void run('open')} className={btn} title="Look up tracking numbers of lines that have not arrived">
              {SCOPE_LABELS.open}
            </button>
            <button
              onClick={() => void run('estimated')}
              className={btn}
              title="Look up arrived lines whose date is only estimated from the reports, to replace it with the carrier's delivery date"
            >
              {SCOPE_LABELS.estimated}
            </button>
          </>
        )}
      </>
    ),
    status: (
      <>
        {totals && (
          <p className="text-sm text-slate-500">
            {running ? `${SCOPE_LABELS[totals.scope]}… ` : ''}
            Checked {totals.checked.toLocaleString()} tracking numbers: {totals.found.toLocaleString()} found
            {totals.notFound > 0 && `, ${totals.notFound.toLocaleString()} not found`}.{' '}
            {totals.linesChanged.toLocaleString()} lines changed
            {totals.arrivalsConfirmed > 0 && `, ${totals.arrivalsConfirmed.toLocaleString()} arrivals confirmed`}.
            {totals.remaining > 0 && ` ${totals.remaining.toLocaleString()} still to check.`}
            {totals.rateLimited && ' Paused: the carrier rate limit was reached, try again shortly.'}
            {totals.stopped && ' Stopped.'}
            {totals.ignoredDeliveries > 0 &&
              ` ${totals.ignoredDeliveries} delivery dates ignored because they predate the ship date (reused tracking numbers).`}
          </p>
        )}
        {error ? <ErrorNote error={error} /> : null}
      </>
    ),
  };
}
