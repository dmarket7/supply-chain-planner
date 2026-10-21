import { useDeferredValue, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ErrorNote } from '../../components/ui';
import { api, qs } from '../../lib/api';

interface Option {
  courierCode: string;
  name: string;
}

/**
 * Pick a TrackingMore courier: suggested candidates, a search over the synced courier list, and (for a
 * shipment) TrackingMore's own detection. Nothing is saved until "Use" is clicked.
 */
export function CourierPicker({
  candidates = [],
  suggested = null,
  detectNumber,
  busy,
  onPick,
  onCancel,
}: {
  candidates?: Option[];
  suggested?: string | null;
  /** Offer "Detect" for this tracking number (asks TrackingMore; free). */
  detectNumber?: string | null;
  busy?: boolean;
  onPick: (courierCode: string) => void;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [selected, setSelected] = useState<string>(suggested ?? '');
  const found = useQuery({
    queryKey: ['couriers', q],
    queryFn: () => api<Option[]>(`/tracking/couriers${qs({ q })}`),
    enabled: q.length >= 2,
  });
  const detect = useMutation({
    mutationFn: () => api<Option[]>('/tracking/detect', { method: 'POST', body: JSON.stringify({ trackingNumber: detectNumber }) }),
  });

  const options = new Map<string, Option & { group: string }>();
  for (const c of detect.data ?? []) options.set(c.courierCode, { ...c, group: 'Detected by TrackingMore' });
  for (const c of candidates) if (!options.has(c.courierCode)) options.set(c.courierCode, { ...c, group: 'Suggested' });
  for (const c of found.data ?? []) if (!options.has(c.courierCode)) options.set(c.courierCode, { ...c, group: 'Search results' });
  const groups = [...new Set([...options.values()].map((o) => o.group))];
  const input = 'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900';

  return (
    <div className="flex min-w-72 flex-col gap-2 whitespace-normal">
      <div className="flex flex-wrap gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search couriers (e.g. DHL)" className={`${input} w-44`} />
        {detectNumber && (
          <button className="rounded-md border border-slate-300 px-2 py-1 text-sm disabled:opacity-40 dark:border-slate-700" onClick={() => detect.mutate()} disabled={detect.isPending}>
            {detect.isPending ? 'Detecting…' : 'Detect'}
          </button>
        )}
      </div>
      <select value={selected} onChange={(e) => setSelected(e.target.value)} className={input} aria-label="Courier">
        <option value="">Choose a courier…</option>
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {[...options.values()]
              .filter((o) => o.group === g)
              .map((o) => (
                <option key={o.courierCode} value={o.courierCode}>
                  {o.name} ({o.courierCode})
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {detect.data && !detect.data.length && <p className="text-xs text-slate-500">TrackingMore couldn't detect a courier for this number.</p>}
      <div className="flex gap-2">
        <button
          className="rounded-md bg-slate-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
          onClick={() => selected && onPick(selected)}
          disabled={!selected || busy}
        >
          Use
        </button>
        <button className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {(found.error || detect.error) && <ErrorNote error={found.error ?? detect.error} />}
    </div>
  );
}
