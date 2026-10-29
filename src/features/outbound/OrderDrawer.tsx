import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ORDER_CHANGE_LABELS, statusText, type OrderLineState } from '../../../shared/orderChanges';
import type { OrderHistoryResponse } from '../../../shared/types';
import { ErrorNote, tableCls, tdCls, thCls } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import { describeCauses, describeChange } from '../../lib/orderChanges';

const FIELDS: { label: string; value: (l: OrderLineState) => string }[] = [
  { label: 'Confirmed ship', value: (l) => formatDate(l.confirmedShipDate, { year: undefined }) },
  { label: 'Customer request (EMS dock)', value: (l) => formatDate(l.dockDate, { year: undefined }) },
  { label: 'System schedule', value: (l) => formatDate(l.scheduledShipDate, { year: undefined }) },
  { label: 'Qty', value: (l) => l.quantity.toLocaleString() },
  { label: 'Reservation', value: (l) => statusText(l.unitsByStatus) },
];

/** One sales order line across every imported report: how its dates moved, why, and the team's notes. */
export function OrderDrawer({ soNumber, cpn, onClose }: { soNumber: string; cpn: string | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const key = ['order-history', soNumber, cpn];
  const { data, error, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api<OrderHistoryResponse>(`/outbound/history${qs({ so: soNumber, cpn: cpn ?? undefined })}`),
  });
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changes = data?.changes ?? [];
  const latest = changes[changes.length - 1];
  const chosen = target || (latest ? `${latest.reportDate}|${latest.kind}` : '');
  const addNote = useMutation({
    mutationFn: () => {
      const [reportDate, kind] = chosen.split('|');
      return api('/outbound/notes', { method: 'POST', body: JSON.stringify({ soNumber, cpn, reportDate, kind, note }) });
    },
    onSuccess: () => {
      setNote('');
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const removeNote = useMutation({
    mutationFn: (id: number) => api(`/outbound/notes/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  const reports = data?.reports ?? [];
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside className="h-full w-full max-w-2xl overflow-y-auto bg-white p-5 shadow-xl dark:bg-slate-950" onClick={(e) => e.stopPropagation()} aria-label="Order history">
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">SO {soNumber}</h2>
            <p className="text-sm text-slate-500">
              {cpn ?? 'No CPN'}
              {reports.find((r) => r.line)?.line?.shipTo && ` · ${reports.find((r) => r.line)!.line!.shipTo}`}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
            Close
          </button>
        </div>
        {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {error && <ErrorNote error={error} />}
        {data && (
          <div className="space-y-6">
            <section className="overflow-x-auto">
              <h3 className="mb-1 text-sm font-medium">By report</h3>
              <p className="mb-2 text-xs text-slate-500">Values that moved since the report before are bold.</p>
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Report</th>
                    {FIELDS.map((f) => <th key={f.label} className={`${thCls} whitespace-nowrap`}>{f.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r, i) => {
                    const prev = reports[i - 1]?.line ?? null;
                    return (
                      <tr key={r.reportDate}>
                        <td className={`${tdCls} whitespace-nowrap`}>{formatDate(r.reportDate)}</td>
                        {r.line ? (
                          FIELDS.map((f) => {
                            const v = f.value(r.line!);
                            const moved = prev && f.value(prev) !== v;
                            return <td key={f.label} className={`${tdCls} text-xs ${moved ? 'font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300'}`}>{v}</td>;
                          })
                        ) : (
                          <td colSpan={FIELDS.length} className={`${tdCls} text-xs text-slate-500`}>
                            Not listed{i > 0 && reports[i - 1].line ? ' (shipped or cancelled)' : ''}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-medium">What changed and why</h3>
              {changes.length === 0 ? (
                <p className="text-sm text-slate-500">No changes between the imported reports.</p>
              ) : (
                <ol className="space-y-3">
                  {[...changes].reverse().map((c) => {
                    const cause = describeCauses(c);
                    const notes = data.notes.filter((n) => n.reportDate === c.reportDate && n.kind === c.kind);
                    return (
                      <li key={`${c.reportDate}|${c.kind}`} className="rounded-md border border-slate-200 p-3 text-sm dark:border-slate-800">
                        <div className="text-xs text-slate-500">
                          {formatDate(c.previousReportDate, { year: undefined })} → {formatDate(c.reportDate)} report
                        </div>
                        <div className="font-medium">{describeChange(c)}</div>
                        {cause && <div className="text-xs text-slate-600 dark:text-slate-300">With it in the report: {cause}</div>}
                        {notes.map((n) => (
                          <div key={n.id} className="mt-2 rounded bg-slate-50 p-2 text-sm dark:bg-slate-900">
                            {n.note}
                            <div className="mt-1 flex gap-2 text-xs text-slate-500">
                              {n.author} · {formatDateTime(n.createdAt)}
                              {n.mine && (
                                <button onClick={() => removeNote.mutate(n.id)} className="hover:underline">
                                  Delete
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            {changes.length > 0 && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (note.trim()) addNote.mutate();
                }}
              >
                <h3 className="text-sm font-medium">Add a note on why</h3>
                <select
                  value={chosen}
                  onChange={(e) => setTarget(e.target.value)}
                  aria-label="Change the note is about"
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                >
                  {[...changes].reverse().map((c) => (
                    <option key={`${c.reportDate}|${c.kind}`} value={`${c.reportDate}|${c.kind}`}>
                      {formatDate(c.reportDate, { year: undefined })}: {ORDER_CHANGE_LABELS[c.kind]}
                    </option>
                  ))}
                </select>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={1000}
                  placeholder="e.g. Supplier confirmed a one-week delay by email"
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
                {addNote.error && <ErrorNote error={addNote.error} />}
                <button
                  type="submit"
                  disabled={!note.trim() || addNote.isPending}
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
                >
                  {addNote.isPending ? 'Saving…' : 'Save note'}
                </button>
              </form>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
