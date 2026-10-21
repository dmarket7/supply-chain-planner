import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CoverageRow } from '../../../shared/types';
import { useBranch } from '../../app/branch';
import { Card, Empty, ErrorNote, PageHeader, tableCls, tdCls, thCls } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useTrackingStatus } from '../shipments/TrackingRefresh';
import { CourierPicker } from './CourierPicker';

interface Coverage {
  registrationProvider: string | null;
  courierList: { count: number; syncedAt: string | null };
  rows: CoverageRow[];
}

interface Preview {
  enabled: boolean;
  linesConsidered: number;
  identitiesToRegister: number;
  linesToRegister: number;
  linesToLink: number;
  alreadyRegisteredIdentities: number;
  directLines: number;
  unresolvedLines: number;
  unsupportedLines: number;
  byCourier: { courierCode: string; courierName: string | null; identities: number; lines: number }[];
  unresolved: { key: string; lines: number; reason: string }[];
}

interface RegisterResult {
  submitted: number;
  registered: number;
  alreadyRegistered: number;
  invalid: number;
  failed: number;
  conflicts: number;
  inProgress: number;
  linesLinked: number;
  quotaExhausted: boolean;
  rateLimited: boolean;
  errors: string[];
  remaining: number;
}

const TM_STATE_TEXT: Record<string, string> = {
  ok: 'Enabled',
  off: 'Off: set TRACKINGMORE_API_KEY and TRACKINGMORE_ENABLED=true',
  disabled: 'Key stored but switched off (TRACKINGMORE_ENABLED is not "true")',
  missing_key: 'TRACKINGMORE_ENABLED is true but TRACKINGMORE_API_KEY is missing',
};

const ROUTE_TEXT: Record<CoverageRow['route'], string> = {
  direct: 'Direct carrier API',
  mapped: 'TrackingMore',
  unsupported: 'Not supported',
  unresolved: 'Needs courier',
};

const ROUTE_STYLE: Record<CoverageRow['route'], string> = {
  direct: 'bg-cyan-50 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200',
  mapped: 'bg-cyan-50 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200',
  unsupported: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  unresolved: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
};

/** Generic carrier values (mirrors server/tracking/couriers.ts). */
const GENERIC = new Set(['forwarder', 'truck', 'air cargo', 'unknown', 'other']);

const btn = 'rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-700';
const primary = 'rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900';

/** TrackingMore setup: courier list, carrier coverage and mappings, and registration with a preview. */
export function TrackingSetupPage() {
  const { branch } = useBranch();
  const queryClient = useQueryClient();
  const status = useTrackingStatus();
  const tmOn = status.data?.trackingMore === 'ok';
  const coverage = useQuery({
    queryKey: ['tracking-coverage', branch],
    queryFn: () => api<Coverage>(`/tracking/coverage${qs({ branch: branch || undefined })}`),
  });
  const sync = useMutation({
    mutationFn: () => api<{ couriers: number }>('/tracking/couriers/sync', { method: 'POST', body: '{}' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tracking-coverage'] }),
  });
  const direct = status.data?.providers.filter((p) => p.kind === 'direct') ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={branch ? `Carrier tracking · ${branch}` : 'Carrier tracking'}
        description="Which carriers can be tracked automatically, and registering shipments with TrackingMore."
      />

      <Card>
        <h2 className="mb-3 text-sm font-medium">Providers</h2>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-slate-500">Direct carrier APIs</dt>
          <dd>{direct.length ? direct.map((p) => `${p.carriers.join(', ')} (${p.name})`).join('; ') : 'None configured'}</dd>
          <dt className="text-slate-500">TrackingMore</dt>
          <dd>{status.data ? TM_STATE_TEXT[status.data.trackingMore] : '…'}</dd>
          <dt className="text-slate-500">Courier list</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {coverage.data?.courierList.count
              ? `${coverage.data.courierList.count.toLocaleString()} couriers, synced ${formatDateTime(coverage.data.courierList.syncedAt)}`
              : 'Not synced yet'}
            {tmOn && (
              <button className={btn} onClick={() => sync.mutate()} disabled={sync.isPending}>
                {sync.isPending ? 'Syncing…' : 'Sync from TrackingMore'}
              </button>
            )}
          </dd>
        </dl>
        <p className="mt-3 text-xs text-slate-500">
          Syncing the courier list and refreshing registered numbers are free. Only registering a new tracking number uses a TrackingMore credit.
        </p>
        {sync.error && <div className="mt-2"><ErrorNote error={sync.error} /></div>}
      </Card>

      <CoverageTable coverage={coverage.data} loading={coverage.isLoading} error={coverage.error} canMap={tmOn && !!coverage.data?.courierList.count} />
      <RegistrationCard enabled={tmOn} />
    </div>
  );
}

function CoverageTable({ coverage, loading, error, canMap }: { coverage?: Coverage; loading: boolean; error: unknown; canMap: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (m: { carrier: string; prefix: string; courierCode: string | null; status: 'mapped' | 'unsupported' }) =>
      api('/tracking/mappings', { method: 'PUT', body: JSON.stringify(m) }),
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries();
    },
  });
  const clear = useMutation({
    mutationFn: (m: { carrier: string; prefix: string }) => api(`/tracking/mappings${qs({ carrier: m.carrier, prefix: m.prefix })}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  return (
    <Card className="overflow-x-auto p-0">
      <div className="p-4 pb-2">
        <h2 className="text-sm font-medium">Carrier coverage</h2>
        <p className="mt-1 text-xs text-slate-500">
          Carriers in the uploaded reports. Generic values such as Forwarder are split by reference prefix (HKG…, CWF…), since each prefix usually belongs to
          one forwarder. A courier is only used once you confirm it here, or per shipment in its detail panel.
        </p>
      </div>
      {error ? (
        <div className="p-4"><ErrorNote error={error} /></div>
      ) : loading ? (
        <div className="p-4 text-sm text-slate-500">Loading…</div>
      ) : !coverage?.rows.length ? (
        <div className="p-4"><Empty>No tracking numbers in the uploaded data.</Empty></div>
      ) : (
        <table className={tableCls}>
          <thead>
            <tr>
              {['Carrier', 'Open lines', 'All lines', 'Numbers', 'Tracked via', 'Registered lines', ''].map((h) => (
                <th key={h} className={`${thCls} whitespace-nowrap`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {coverage.rows.map((r) => {
              const id = `${r.carrier}|${r.prefix}`;
              return (
                <tr key={id} className="align-top">
                  <td className={`${tdCls} whitespace-nowrap font-medium`}>{r.label}</td>
                  <td className={`${tdCls} tabular-nums`}>{r.openLines.toLocaleString()}</td>
                  <td className={`${tdCls} tabular-nums`}>{r.lines.toLocaleString()}</td>
                  <td className={`${tdCls} tabular-nums`}>{r.numbers.toLocaleString()}</td>
                  <td className={tdCls}>
                    <span className={`inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ${ROUTE_STYLE[r.route]}`}>{ROUTE_TEXT[r.route]}</span>
                    {r.courierCode && (
                      <span className="ml-1.5 text-xs text-slate-600 dark:text-slate-300">
                        {r.courierName ?? r.courierCode} <span className="font-mono text-slate-400">{r.courierCode}</span>
                      </span>
                    )}
                    {r.route === 'unresolved' && r.ambiguous && r.candidates.length > 1 && (
                      <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">Several services match; pick the right one.</div>
                    )}
                    {r.overrideLines > 0 && <div className="mt-1 text-xs text-slate-500">{r.overrideLines} line(s) have a courier chosen per shipment</div>}
                  </td>
                  <td className={`${tdCls} tabular-nums`}>{r.registeredLines.toLocaleString()}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>
                    {r.route === 'direct' ? null : editing === id ? (
                      <CourierPicker
                        candidates={r.candidates}
                        suggested={r.suggested}
                        busy={save.isPending}
                        onCancel={() => setEditing(null)}
                        onPick={(code) => save.mutate({ carrier: r.carrier, prefix: r.prefix, courierCode: code, status: 'mapped' })}
                      />
                    ) : (
                      <div className="flex gap-2">
                        {canMap && r.route === 'unresolved' && !r.prefix && GENERIC.has(r.carrier.toLowerCase()) ? (
                          <span className="text-xs text-slate-500">Mixed carriers: choose per shipment</span>
                        ) : canMap && (
                          <button className={btn} onClick={() => setEditing(id)}>
                            {r.route === 'mapped' ? 'Change courier' : 'Choose courier'}
                          </button>
                        )}
                        {canMap && r.route !== 'unsupported' && (
                          <button className={btn} onClick={() => save.mutate({ carrier: r.carrier, prefix: r.prefix, courierCode: null, status: 'unsupported' })}>
                            Not supported
                          </button>
                        )}
                        {(r.route === 'mapped' || r.route === 'unsupported') && canMap && (
                          <button className={btn} onClick={() => clear.mutate({ carrier: r.carrier, prefix: r.prefix })}>
                            Reset
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {!canMap && coverage && (
        <p className="p-4 text-xs text-slate-500">
          {coverage.registrationProvider ? 'Sync the TrackingMore courier list to map carriers.' : 'Enable TrackingMore to map carriers to its couriers.'}
        </p>
      )}
      {(save.error || clear.error) && <div className="p-4"><ErrorNote error={save.error ?? clear.error} /></div>}
    </Card>
  );
}

function RegistrationCard({ enabled }: { enabled: boolean }) {
  const { branch } = useBranch();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<'open' | 'recent'>('open');
  const [recentDays, setRecentDays] = useState(30);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<RegisterResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const stop = useRef(false);
  const body = { scope, branch: branch || null, recentDays };
  const preview = useQuery({
    queryKey: ['register-preview', scope, recentDays, branch],
    queryFn: () => api<Preview>('/tracking/register/preview', { method: 'POST', body: JSON.stringify(body) }),
  });
  const p = preview.data;
  const credits = p?.identitiesToRegister ?? 0;

  async function register() {
    stop.current = false;
    setRunning(true);
    setError(null);
    let t: RegisterResult = { submitted: 0, registered: 0, alreadyRegistered: 0, invalid: 0, failed: 0, conflicts: 0, inProgress: 0, linesLinked: 0, quotaExhausted: false, rateLimited: false, errors: [], remaining: 0 };
    setTotals(t);
    try {
      for (;;) {
        const r = await api<RegisterResult>('/tracking/register', { method: 'POST', body: JSON.stringify({ ...body, confirm: true }) });
        t = {
          ...r,
          submitted: t.submitted + r.submitted,
          registered: t.registered + r.registered,
          alreadyRegistered: t.alreadyRegistered + r.alreadyRegistered,
          invalid: t.invalid + r.invalid,
          failed: t.failed + r.failed,
          conflicts: t.conflicts + r.conflicts,
          inProgress: t.inProgress + r.inProgress,
          linesLinked: t.linesLinked + r.linesLinked,
          errors: [...t.errors, ...r.errors],
        };
        setTotals(t);
        // Stop when done, throttled, out of quota, or when a batch only failed (it would fail again).
        if (r.remaining === 0 || r.submitted === 0 || r.quotaExhausted || r.rateLimited || r.failed === r.submitted || stop.current) break;
      }
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
      setConfirmed(false);
      void queryClient.invalidateQueries();
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-medium">Register with TrackingMore</h2>
      <p className="mt-1 text-xs text-slate-500">
        TrackingMore only tracks numbers registered with it, and each new registration uses one credit. Numbers already registered are linked to new PO
        lines for free and are never registered twice. After registering, use <Link to="/shipments" className="underline">Refresh tracking</Link> on the
        Shipments page to fetch updates (free).
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={scope === 'open'} onChange={() => setScope('open')} /> Shipments not arrived yet
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={scope === 'recent'} onChange={() => setScope('recent')} /> Arrivals estimated from reports in the last
          <select
            value={recentDays}
            onChange={(e) => setRecentDays(Number(e.target.value))}
            disabled={scope !== 'recent'}
            className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
          >
            {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
        {branch && <span className="text-slate-500">Branch: {branch}</span>}
      </div>

      {preview.error ? <div className="mt-3"><ErrorNote error={preview.error} /></div> : null}
      {p && (
        <div className="mt-4 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="New tracking numbers to register" value={credits} hint={`${p.linesToRegister.toLocaleString()} PO lines · ${credits.toLocaleString()} credits`} strong />
            <Stat label="Already registered" value={p.alreadyRegisteredIdentities} hint={p.linesToLink ? `${p.linesToLink} new lines will be linked (free)` : 'no credits'} />
            <Stat label="Need a courier" value={p.unresolvedLines} hint="lines; map them above" />
            <Stat label="Other" value={p.directLines + p.unsupportedLines} hint={`${p.directLines} via carrier API · ${p.unsupportedLines} not supported`} />
          </div>
          {p.byCourier.length > 0 && (
            <p className="text-xs text-slate-500">
              By courier: {p.byCourier.map((c) => `${c.courierName ?? c.courierCode} ${c.identities}`).join(' · ')}
            </p>
          )}
          {p.unresolved.length > 0 && (
            <p className="text-xs text-slate-500">
              Unresolved: {p.unresolved.slice(0, 8).map((u) => `${u.key} (${u.lines})`).join(', ')}
              {p.unresolved.length > 8 ? ` and ${p.unresolved.length - 8} more` : ''}
            </p>
          )}
          {enabled ? (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={!credits && !p.linesToLink} />
                I understand this uses up to {credits.toLocaleString()} TrackingMore credit{credits === 1 ? '' : 's'}
              </label>
              {running ? (
                <button className={btn} onClick={() => (stop.current = true)}>Stop</button>
              ) : (
                <button className={primary} onClick={() => void register()} disabled={!confirmed || (!credits && !p.linesToLink)}>
                  {credits ? `Register ${credits.toLocaleString()} tracking number${credits === 1 ? '' : 's'}` : `Link ${p.linesToLink} lines`}
                </button>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Enable TrackingMore to register shipments.</p>
          )}
        </div>
      )}
      {totals && (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          {running ? 'Registering… ' : ''}
          Sent {totals.submitted}: {totals.registered} registered
          {totals.alreadyRegistered ? `, ${totals.alreadyRegistered} were already registered (no credit)` : ''}
          {totals.invalid ? `, ${totals.invalid} rejected as invalid` : ''}
          {totals.conflicts ? `, ${totals.conflicts} reused-number conflicts` : ''}
          {totals.failed ? `, ${totals.failed} failed (can be retried)` : ''}. {totals.linesLinked} PO lines linked.
          {totals.inProgress ? ` ${totals.inProgress} were being registered by someone else.` : ''}
          {totals.quotaExhausted && ' Stopped: TrackingMore quota used up.'}
          {totals.rateLimited && ' Paused: TrackingMore rate limit; try again shortly.'}
          {totals.remaining > 0 && !running ? ` ${totals.remaining} still to register.` : ''}
        </p>
      )}
      {totals?.errors.length ? <p className="mt-1 text-xs text-red-700 dark:text-red-300">{totals.errors[0]}</p> : null}
      {error ? <div className="mt-3"><ErrorNote error={error} /></div> : null}
    </Card>
  );
}

function Stat({ label, value, hint, strong }: { label: string; value: number; hint?: string; strong?: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${strong ? 'border-slate-400 dark:border-slate-500' : 'border-slate-200 dark:border-slate-800'}`}>
      <div className="text-xl font-semibold tabular-nums">{value.toLocaleString()}</div>
      <div className="text-xs text-slate-500">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}
