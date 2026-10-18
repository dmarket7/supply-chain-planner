import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { todayIso } from '../../../shared/dates';
import type { ShipmentDetail } from '../../../shared/types';
import { ErrorNote, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { ARRIVAL_SOURCE_LABELS, STATUS_LABELS, arrivalLabel, formatDate, poLineLabel } from '../../lib/format';
import { ESTIMATED_ARRIVAL_SOURCES } from '../../../shared/types';

export function ShipmentDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['shipment', id],
    queryFn: () => api<ShipmentDetail>(`/shipments/${id}`),
  });
  const [arrival, setArrival] = useState(todayIso());
  useEffect(() => {
    if (data?.actualArrivalDate) setArrival(data.actualArrivalDate);
  }, [data?.actualArrivalDate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setArrivalMutation = useMutation({
    mutationFn: (actualArrivalDate: string | null) =>
      api(`/shipments/${id}/arrival`, { method: 'PATCH', body: JSON.stringify({ actualArrivalDate }) }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right">{value ?? '—'}</dd>
    </div>
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        className="h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-xl dark:bg-slate-950"
        onClick={(e) => e.stopPropagation()}
        aria-label="Shipment details"
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">{data ? poLineLabel(data) : 'Shipment'}</h2>
            {data && <p className="text-sm text-slate-500">{data.supplier}</p>}
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">Close</button>
        </div>
        {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {error && <ErrorNote error={error} />}
        {data && (
          <div className="space-y-6">
            <dl className="divide-y divide-slate-100 dark:divide-slate-900">
              {row('Status', <StatusBadge status={data.status} />)}
              {row('PO status', data.poStatus)}
              {row('ASN / delivery', data.asn && <span className="font-mono text-xs">{data.asn}</span>)}
              {row('Customer PO', data.customerPo)}
              {row('Part', data.partNumber)}
              {row('Item', data.itemDescription)}
              {row('Commodity', data.commodity)}
              {row('Quantity', data.quantity?.toLocaleString())}
              {row('Warehouse', data.warehouse)}
              {row('Carrier', data.carrier && `${data.carrier}${data.mode ? ` (${data.mode})` : ''}`)}
              {row('Tracking #', data.trackingNumber && <span className="font-mono text-xs">{data.trackingNumber}</span>)}
              {row('Tracking ref', data.trackingRef && <span className="font-mono text-xs">{data.trackingRef}</span>)}
              {row('Customer request (CRD)', formatDate(data.requestDate))}
              {row('Shipped (ETD)', formatDate(data.shipDate))}
              {row('Supplier ETA', formatDate(data.promisedArrivalDate))}
              {row('Carrier ETA', formatDate(data.estimatedArrivalDate))}
              {row(
                'Arrived',
                data.actualArrivalDate
                  ? `${arrivalLabel(data)}${data.arrivalSource ? ` · ${ARRIVAL_SOURCE_LABELS[data.arrivalSource]}` : ''}`
                  : null,
              )}
            </dl>

            <section>
              <h3 className="mb-2 text-sm font-medium">Arrival</h3>
              {data.arrivalSource && ESTIMATED_ARRIVAL_SOURCES.includes(data.arrivalSource) && (
                <p className="mb-2 text-sm text-slate-500">
                  {data.arrivalSource === 'report_window'
                    ? `Estimated: the line closed between the ${formatDate(data.arrivalWindowStart)} and ${formatDate(data.arrivalWindowEnd)} reports. `
                    : 'Assumed on the supplier ETA: the line was already closed in the first report it appeared in. '}
                  Tracking data or a confirmed date replaces this estimate.
                </p>
              )}
              {data.actualArrivalDate && !(data.arrivalSource && ESTIMATED_ARRIVAL_SOURCES.includes(data.arrivalSource)) ? (
                <button
                  onClick={() => setArrivalMutation.mutate(null)}
                  disabled={setArrivalMutation.isPending}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
                >
                  Clear arrival
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={arrival}
                    onChange={(e) => setArrival(e.target.value)}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                  />
                  <button
                    onClick={() => setArrivalMutation.mutate(arrival)}
                    disabled={!arrival || setArrivalMutation.isPending}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
                  >
                    {data.actualArrivalDate ? 'Confirm arrival date' : 'Mark arrived'}
                  </button>
                </div>
              )}
              {setArrivalMutation.error && <div className="mt-2"><ErrorNote error={setArrivalMutation.error} /></div>}
            </section>

            {data.promisedDateHistory.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-medium">Promised date changes</h3>
                <ul className="space-y-1 text-sm">
                  {data.promisedDateHistory.map((h, i) => (
                    <li key={i} className="text-slate-600 dark:text-slate-300">
                      {formatDate(h.previousDate)} → {formatDate(h.newDate)}
                      <span className="text-slate-500"> (report of {formatDate(h.changedAt)})</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h3 className="mb-2 text-sm font-medium">Tracking history</h3>
              {data.events.length === 0 ? (
                <p className="text-sm text-slate-500">No tracking events yet. Carrier tracking will be added in a later phase.</p>
              ) : (
                <ol className="space-y-3 border-l border-slate-200 pl-4 dark:border-slate-800">
                  {data.events.map((e) => (
                    <li key={e.id} className="text-sm">
                      <div className="font-medium">{e.description ?? STATUS_LABELS[e.status]}</div>
                      <div className="text-slate-500">
                        {new Date(e.occurredAt).toLocaleString()}
                        {e.location && ` · ${e.location}`}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
