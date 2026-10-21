/**
 * TrackingMore lists "API" variants of big carriers (fedex-unified-api, ups-unified-api, dhl-unified-api,
 * …). They pull from the carrier's own API through a carrier account connected in TrackingMore; without
 * one, registrations stay "pending" with no scans. The plain code (fedex, ups, dhl) is standard tracking.
 */
export function needsCarrierAccount(courierCode: string, name?: string | null) {
  return /-(unified-)?api$/i.test(courierCode) || /\bAPI$/.test(name?.trim() ?? '');
}

export const CARRIER_ACCOUNT_NOTE = 'Needs your own carrier account connected in TrackingMore; without it no scans come back.';

/** Hours after registration with no scans at all before we suggest the courier may be wrong. */
export const STALLED_AFTER_HOURS = 6;

export function isStalledRegistration(
  r: { state: string; registeredAt: string | null; latestCheckpointAt: string | null },
  now: Date = new Date(),
) {
  if (r.state !== 'awaiting_data' || r.latestCheckpointAt || !r.registeredAt) return false;
  return now.getTime() - new Date(r.registeredAt).getTime() > STALLED_AFTER_HOURS * 3_600_000;
}
