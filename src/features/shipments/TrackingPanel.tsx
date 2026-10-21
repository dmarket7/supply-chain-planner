import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ShipmentDetail } from '../../../shared/types';
import { ErrorNote, TrackingBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { PROVIDER_NAMES, formatDate, formatDateTime } from '../../lib/format';
import { CARRIER_ACCOUNT_NOTE, needsCarrierAccount } from '../../../shared/couriers';
import { CourierPicker } from '../tracking/CourierPicker';
import { useTrackingStatus } from './TrackingRefresh';

const btn = 'rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-700';

/**
 * A shipment's carrier tracking: provider, courier, registration state, latest checkpoint, sync times
 * and problems, plus the actions that apply (choose courier, register, look up now).
 */
export function TrackingPanel({ shipment: s }: { shipment: ShipmentDetail }) {
  const queryClient = useQueryClient();
  const status = useTrackingStatus();
  const tmOn = status.data?.trackingMore === 'ok';
  const t = s.tracking;
  const reg = t?.registration ?? null;
  const [picking, setPicking] = useState(false);
  const [confirmRegister, setConfirmRegister] = useState(false);
  const invalidate = () => void queryClient.invalidateQueries();

  const lookup = useMutation({
    mutationFn: () =>
      api<{ found: number; linesChanged: number }>('/tracking/refresh', { method: 'POST', body: JSON.stringify({ scope: 'line', shipmentIds: [s.id], force: true }) }),
    onSuccess: invalidate,
  });
  const override = useMutation({
    mutationFn: (courierCode: string | null) => api<{ lines: number }>('/tracking/override', { method: 'PUT', body: JSON.stringify({ shipmentId: s.id, courierCode }) }),
    onSuccess: () => {
      setPicking(false);
      invalidate();
    },
  });
  const register = useMutation({
    mutationFn: async () => {
      const r = await api<{ registered: number; alreadyRegistered: number; invalid: number; failed: number; conflicts: number; linesLinked: number }>('/tracking/register', {
        method: 'POST',
        body: JSON.stringify({ scope: 'line', shipmentIds: [s.id], confirm: true }),
      });
      // Fetch whatever TrackingMore already has (free); a brand-new number usually has no scans yet.
      if (r.registered || r.alreadyRegistered) await api('/tracking/refresh', { method: 'POST', body: JSON.stringify({ scope: 'line', shipmentIds: [s.id], force: true }) }).catch(() => null);
      return r;
    },
    onSuccess: () => {
      setConfirmRegister(false);
      invalidate();
    },
  });

  if (!s.trackingNumber || !t) return null;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right">{value ?? '—'}</dd>
    </div>
  );
  const canLookUp = t.label === 'direct' || (!!reg && ['awaiting_data', 'active', 'unavailable', 'api_error'].includes(t.label) && reg.state !== 'missing' && reg.state !== 'conflict' && reg.state !== 'register_failed');
  const canRegister = tmOn && !!t.courierCode && (t.label === 'not_registered' || (reg && ['register_failed', 'missing'].includes(reg.state)));
  const canPick = tmOn && t.label !== 'direct';

  return (
    <section>
      <h3 className="mb-2 flex items-center justify-between gap-2 text-sm font-medium">
        Carrier tracking
        <TrackingBadge tracking={t} />
      </h3>
      <dl className="divide-y divide-slate-100 dark:divide-slate-900">
        {row('Provider', t.provider ? (PROVIDER_NAMES[t.provider] ?? t.provider) : 'None')}
        {row('Carrier (from report)', s.carrier)}
        {t.courierCode &&
          row(
            'Courier',
            <span>
              {t.courierName ?? t.courierCode} <span className="font-mono text-xs text-slate-400">{t.courierCode}</span>
              <span className="block text-xs text-slate-500">{t.courierSource === 'override' ? 'chosen for this shipment' : 'from the carrier mapping'}</span>
              {needsCarrierAccount(t.courierCode, t.courierName) && <span className="block max-w-56 text-xs text-amber-700 dark:text-amber-300">{CARRIER_ACCOUNT_NOTE}</span>}
            </span>,
          )}
        {reg && row('Provider status', [reg.lastProviderStatus, reg.lastProviderSubstatus].filter(Boolean).join(' · ') || null)}
        {reg?.latestEvent &&
          row(
            'Latest checkpoint',
            <span>
              {reg.latestEvent}
              {reg.latestCheckpointAt && <span className="block text-xs text-slate-500">{formatDateTime(reg.latestCheckpointAt)}</span>}
            </span>,
          )}
        {row('Carrier ETA', s.estimatedArrivalDate ? formatDate(s.estimatedArrivalDate) : null)}
        {row('Last successful sync', reg?.lastSuccessAt ? formatDateTime(reg.lastSuccessAt) : s.trackingFound && s.lastTrackedAt ? formatDateTime(s.lastTrackedAt) : null)}
        {reg?.registeredAt && row('Registered', formatDateTime(reg.registeredAt))}
      </dl>

      {t.reason && <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">{t.reason}</p>}
      {t.label === 'awaiting_data' && (
        <p className="mt-2 text-sm text-slate-500">TrackingMore has registered this number and is waiting for the carrier's first scan. This usually takes a few hours.</p>
      )}
      {reg?.lastError && (t.label === 'api_error' || reg.state === 'invalid') && <p className="mt-2 text-sm text-red-700 dark:text-red-300">{reg.lastError}</p>}
      {reg?.lastWarning && <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">{reg.lastWarning}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canLookUp && (
          <button className={btn} onClick={() => lookup.mutate()} disabled={lookup.isPending}>
            {lookup.isPending ? 'Looking up…' : 'Look up now'}
          </button>
        )}
        {canPick && !picking && (
          <button className={btn} onClick={() => setPicking(true)}>
            {t.courierSource === 'override' ? 'Change courier' : t.label === 'unresolved' || t.label === 'unsupported' ? 'Choose courier' : 'Use another courier'}
          </button>
        )}
        {t.courierSource === 'override' && !picking && (
          <button className={btn} onClick={() => override.mutate(null)} disabled={override.isPending}>
            Clear chosen courier
          </button>
        )}
        {lookup.data && (
          <span className="text-sm text-slate-500">{lookup.data.found ? (lookup.data.linesChanged ? 'Updated.' : 'No changes since the last check.') : 'No data from the provider yet.'}</span>
        )}
      </div>

      {picking && (
        <div className="mt-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <p className="mb-2 text-xs text-slate-500">Applies to every PO line with tracking number {s.trackingNumber} from {s.carrier ?? 'this carrier'}.</p>
          <CourierPicker
            detectNumber={s.trackingNumber}
            current={t.courierCode}
            notice={reg ? `Registered under ${reg.courierCode} now. Registering under another courier uses 1 credit.` : null}
            busy={override.isPending} onPick={(code) => override.mutate(code)} onCancel={() => setPicking(false)} />
        </div>
      )}

      {canRegister && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={confirmRegister} onChange={(e) => setConfirmRegister(e.target.checked)} />
            Uses 1 TrackingMore credit (none if already registered)
          </label>
          <button
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
            onClick={() => register.mutate()}
            disabled={!confirmRegister || register.isPending}
          >
            {register.isPending ? 'Registering…' : 'Register with TrackingMore'}
          </button>
          {register.data && (
            <span className="text-slate-500">
              {register.data.registered ? 'Registered.' : register.data.alreadyRegistered ? 'Already registered; linked.' : register.data.invalid ? 'TrackingMore rejected the number or courier.' : register.data.conflicts ? 'Conflict: TrackingMore tracks an earlier shipment with this number.' : register.data.failed ? 'Registration failed; try again.' : register.data.linesLinked ? 'Linked to the existing registration.' : 'Nothing to register.'}
            </span>
          )}
        </div>
      )}
      {(lookup.error || override.error || register.error) && <div className="mt-2"><ErrorNote error={lookup.error ?? override.error ?? register.error} /></div>}
    </section>
  );
}
