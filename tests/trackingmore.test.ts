import { describe, expect, it } from 'vitest';
import { applyTrackingResult } from '../server/tracking/apply';
import { TrackingRateLimitError } from '../server/tracking/provider';
import {
  TrackingMoreAuthError,
  TrackingMoreError,
  TrackingMoreQuotaError,
  trackingMoreClient,
  type TrackingMoreTracking,
} from '../server/tracking/trackingmore/client';
import {
  parseTrackingMoreTime,
  parseTrackingMoreTracking,
  registrationStateFor,
  trackingMoreStatus,
} from '../server/tracking/trackingmore/normalize';
import { trackingMoreProvider } from '../server/tracking/trackingmore/provider';

// ─── Mock API ─────────────────────────────────────────────────────────────────────────────────────

const ok = (data: unknown) => ({ meta: { code: 200, message: 'Request response is successful' }, data });
const meta = (code: number, message: string) => ({ meta: { code, message }, data: [] });

function mockApi(handler: (method: string, path: string, url: URL, body: unknown) => { status?: number; json?: unknown; text?: string }) {
  const calls: { method: string; path: string; url: URL; body: unknown; key: string | null }[] = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace('/v4', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', path, url, body, key: new Headers(init.headers).get('Tracking-Api-Key') });
    const r = handler(init.method ?? 'GET', path, url, body);
    return new Response(r.text ?? JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, client: trackingMoreClient('secret-key', fetchImpl) };
}

/** Shaped like the V4 Tracking object (SDK `Tracking` struct). */
const inTransit: TrackingMoreTracking = {
  id: '9a1339c0b0f1d2c4a0e2a4b3',
  tracking_number: 'CWF12345678901',
  courier_code: 'dsv',
  created_at: '2026-10-14T08:00:00+00:00',
  update_at: '2026-10-16T09:00:00+00:00',
  delivery_status: 'transit',
  substatus: 'transit001',
  status_info: null,
  latest_event: 'Departed from origin airport,Hong Kong',
  latest_checkpoint_time: '2026-10-16T03:00:00+08:00',
  scheduled_delivery_date: '2026-10-22',
  archived: 'tracking',
  updating: false,
  origin_info: {
    courier_code: 'dsv',
    milestone_date: { pickup_date: '2026-10-14 10:00' },
    // V4 lists are newest-first; checkpoint times are often zoneless.
    trackinfo: [
      { checkpoint_date: '2026-10-16T03:00:00+08:00', checkpoint_delivery_status: 'transit', checkpoint_delivery_substatus: 'transit007', tracking_detail: 'Departed from origin airport', location: 'Hong Kong', country_iso2: 'HK', state: null, city: null, zip: null, raw_status: null },
      { checkpoint_date: '2026-10-14 10:00', checkpoint_delivery_status: 'pickup', checkpoint_delivery_substatus: null, tracking_detail: 'Picked up', location: null, country_iso2: 'TW', state: null, city: 'Taipei', zip: null, raw_status: null },
      { checkpoint_date: '', checkpoint_delivery_status: 'transit', checkpoint_delivery_substatus: null, tracking_detail: 'Booking received', location: null, country_iso2: null, state: null, city: null, zip: null, raw_status: null },
    ],
  },
  destination_info: { trackinfo: [] },
};

const delivered = (deliveryDate: string | null, checkpointDate: string | null): TrackingMoreTracking => ({
  ...inTransit,
  delivery_status: 'delivered',
  substatus: 'delivered001',
  scheduled_delivery_date: '2026-10-22',
  destination_info: {
    milestone_date: { delivery_date: deliveryDate },
    trackinfo: checkpointDate
      ? [{ checkpoint_date: checkpointDate, checkpoint_delivery_status: 'delivered', checkpoint_delivery_substatus: 'delivered001', tracking_detail: 'Delivered', location: 'San Jose, CA', country_iso2: 'US', state: null, city: null, zip: null, raw_status: null }]
      : [],
  },
});

// ─── Client ───────────────────────────────────────────────────────────────────────────────────────

describe('TrackingMore client', () => {
  it('authenticates with the Tracking-Api-Key header against the V4 base URL', async () => {
    const { calls, client } = mockApi(() => ({ json: ok([{ courier_name: 'DSV', courier_code: 'dsv', courier_type: 'express' }]) }));
    expect(await client.listCouriers()).toEqual([expect.objectContaining({ courier_code: 'dsv', courier_name: 'DSV' })]);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/couriers/all', key: 'secret-key' });
    expect(calls[0].url.origin).toBe('https://api.trackingmore.com');
  });

  it('drops malformed courier entries instead of failing', async () => {
    const { client } = mockApi(() => ({ json: ok([{ courier_name: 'No code' }, { courier_code: 'ups', courier_name: 'UPS', courier_country_iso2: 7 }, 'junk']) }));
    expect((await client.listCouriers()).map((c) => [c.courier_code, c.courier_country_iso2])).toEqual([['ups', '7']]);
  });

  it('detects couriers and treats "cannot detect" as no candidates', async () => {
    let n = 0;
    const { calls, client } = mockApi(() => (++n === 1 ? { json: ok([{ courier_code: 'dhl', courier_name: 'DHL Express' }, { courier_code: 'dhl-global-mail', courier_name: 'DHL eCommerce' }]) } : { status: 400, json: meta(4121, 'Cannot detect courier.') }));
    expect((await client.detectCouriers('1234567890')).map((c) => c.courier_code)).toEqual(['dhl', 'dhl-global-mail']);
    expect(calls[0].body).toEqual({ tracking_number: '1234567890' });
    expect(await client.detectCouriers('???')).toEqual([]);
  });

  it('registers a single number and reads the returned tracking', async () => {
    const { calls, client } = mockApi(() => ({ json: ok(inTransit) }));
    const r = await client.createTracking({ tracking_number: 'CWF12345678901', courier_code: 'dsv' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/trackings/create', body: { tracking_number: 'CWF12345678901', courier_code: 'dsv' } });
    expect(r).toMatchObject({ outcome: 'created', id: '9a1339c0b0f1d2c4a0e2a4b3' });
  });

  it('reports an already registered number as "exists", not an error', async () => {
    const { client } = mockApi(() => ({ status: 400, json: meta(4101, 'Tracking No. already exists.') }));
    expect(await client.createTracking({ tracking_number: 'X1', courier_code: 'dsv' })).toEqual({ outcome: 'exists' });
  });

  it('registers in batches and returns per-number successes and errors', async () => {
    const { calls, client } = mockApi(() => ({
      json: ok({
        success: [{ id: 'a1', tracking_number: 'N1', courier_code: 'dsv' }],
        error: [
          { tracking_number: 'N2', courier_code: 'dsv', errorCode: 4101, errorMessage: 'Tracking No. already exists.' },
          { tracking_number: 'N3', courier_code: 'dsv', errorCode: 4110, errorMessage: 'The value of tracking_number is invalid.' },
        ],
      }),
    }));
    const r = await client.batchCreate(['N1', 'N2', 'N3'].map((n) => ({ tracking_number: n, courier_code: 'dsv' })));
    expect(calls[0]).toMatchObject({ path: '/trackings/batch' });
    expect(calls[0].body).toHaveLength(3);
    expect(r.success.map((s) => s.id)).toEqual(['a1']);
    expect(r.error.map((e) => [e.tracking_number, e.errorCode])).toEqual([['N2', 4101], ['N3', 4110]]);
    await expect(client.batchCreate(Array.from({ length: 41 }, (_, i) => ({ tracking_number: `N${i}`, courier_code: 'dsv' })))).rejects.toThrow(/At most 40/);
  });

  it('retrieves registered trackings by number and courier; "never created" is an empty result', async () => {
    let n = 0;
    const { calls, client } = mockApi(() => (++n === 1 ? { json: ok([inTransit, { broken: true }]) } : { status: 400, json: meta(4102, 'Tracking No. no exists.') }));
    const got = await client.getTrackings({ trackingNumbers: ['CWF12345678901', 'X'], courierCode: 'dsv' });
    expect(got.map((t) => t.tracking_number)).toEqual(['CWF12345678901']);
    expect(calls[0].url.searchParams.get('tracking_numbers')).toBe('CWF12345678901,X');
    expect(calls[0].url.searchParams.get('courier_code')).toBe('dsv');
    expect(await client.getTrackings({ trackingNumbers: ['Y'], courierCode: 'dsv' })).toEqual([]);
  });

  it.each([
    [401, meta(401, 'Authentication failed'), TrackingMoreAuthError],
    [403, { text: 'Forbidden' }, TrackingMoreAuthError],
    [400, meta(4190, 'You are reaching the maximum quota limitation'), TrackingMoreQuotaError],
    [502, { text: '<html>Bad gateway</html>' }, TrackingMoreError],
  ])('maps HTTP %s failures to typed errors', async (status, body, type) => {
    const { client } = mockApi(() => ('text' in (body as object) ? { status, text: (body as { text: string }).text } : { status, json: body }));
    const err = await client.listCouriers().catch((e) => e);
    expect(err).toBeInstanceOf(type);
    if (status === 502) expect(err.transient).toBe(true);
    // The key never appears in error messages.
    expect(String(err.message)).not.toContain('secret-key');
  });

  it('maps 429 to a rate-limit error with the retry delay', async () => {
    const fetchImpl = (async () => new Response('', { status: 429, headers: { 'retry-after': '12' } })) as unknown as typeof fetch;
    const err = await trackingMoreClient('k', fetchImpl).listCouriers().catch((e) => e);
    expect(err).toBeInstanceOf(TrackingRateLimitError);
    expect(err.retryAfterSeconds).toBe(12);
  });

  it('reports network failures as transient', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const err = await trackingMoreClient('k', fetchImpl).listCouriers().catch((e) => e);
    expect(err).toBeInstanceOf(TrackingMoreError);
    expect(err.transient).toBe(true);
  });
});

// ─── Normalization ────────────────────────────────────────────────────────────────────────────────

describe('TrackingMore normalization', () => {
  it.each([
    ['inforeceived', false, 'pending'],
    ['pending', false, null],
    ['pending', true, 'pending'],
    ['transit', true, 'in_transit'],
    ['pickup', true, 'out_for_delivery'],
    ['delivered', true, 'delivered'],
    ['undelivered', true, 'exception'],
    ['exception', true, 'exception'],
    ['notfound', false, null],
    ['expired', true, null],
    ['something_new', true, null],
  ])('%s (scans: %s) -> %s', (status, scans, expected) => {
    expect(trackingMoreStatus(status, scans)).toBe(expected);
  });

  it('parses offset, zoneless and space-separated times without shifting the local date', () => {
    expect(parseTrackingMoreTime('2026-10-16T03:00:00+08:00')).toEqual({ iso: '2026-10-15T19:00:00.000Z', local: '2026-10-16T03:00:00+08:00' });
    expect(parseTrackingMoreTime('2026-10-14 10:00')).toEqual({ iso: '2026-10-14T10:00:00.000Z', local: '2026-10-14T10:00:00' });
    expect(parseTrackingMoreTime('2026-10-22')?.local).toBe('2026-10-22T00:00:00');
    expect(parseTrackingMoreTime('+0800 2026')).toBeNull();
    expect(parseTrackingMoreTime('')).toBeNull();
  });

  it('extracts status, ETA, checkpoints and provider details', () => {
    const r = parseTrackingMoreTracking(inTransit, { now: new Date('2026-10-17T00:00:00Z') });
    expect(r).toMatchObject({
      status: 'in_transit',
      estimatedArrivalDate: '2026-10-22',
      deliveredAt: undefined,
      carrier: 'dsv',
      providerStatus: 'transit',
      providerSubstatus: 'transit001',
      latestEvent: 'Departed from origin airport,Hong Kong',
      latestCheckpointAt: '2026-10-15T19:00:00.000Z',
      providerTrackingId: '9a1339c0b0f1d2c4a0e2a4b3',
      registrationState: 'active',
      undatedCheckpoints: 1,
    });
    expect(r.events.map((e) => [e.occurredAt, e.status, e.location])).toEqual([
      ['2026-10-15T19:00:00.000Z', 'in_transit', 'Hong Kong'],
      ['2026-10-14T10:00:00.000Z', 'out_for_delivery', 'Taipei, TW'],
    ]);
  });

  it('takes the delivery date in the carrier\'s local time', () => {
    const r = parseTrackingMoreTracking(delivered('2026-10-20T21:30:00-07:00', null));
    expect(r).toMatchObject({ status: 'delivered', deliveredAt: '2026-10-20T21:30:00-07:00', estimatedArrivalDate: undefined, discrepancy: null });
    const line = { id: 1, status: 'in_transit' as const, shipDate: '2026-10-14', actualArrivalDate: null, arrivalSource: null };
    // 21:30 in California is Oct 21 in UTC; the arrival date stays Oct 20.
    expect(applyTrackingResult(line, r)).toMatchObject({ actualArrivalDate: '2026-10-20', arrivalSource: 'tracking', confirmedArrival: true });
  });

  it('falls back to the delivered checkpoint when there is no delivery milestone', () => {
    expect(parseTrackingMoreTracking(delivered(null, '2026-10-21 09:15')).deliveredAt).toBe('2026-10-21T09:15:00');
  });

  it('records a discrepancy instead of inventing an arrival when "delivered" has no time', () => {
    const r = parseTrackingMoreTracking(delivered(null, null));
    expect(r.deliveredAt).toBeUndefined();
    expect(r.discrepancy).toMatch(/no delivery time/);
    const line = { id: 1, status: 'in_transit' as const, shipDate: '2026-10-14', actualArrivalDate: null, arrivalSource: null };
    expect(applyTrackingResult(line, r)).toMatchObject({ actualArrivalDate: null, arrivalSource: null, confirmedArrival: false });
  });

  it('treats pending/notfound without scans as awaiting data, not as a failure', () => {
    const empty = { ...inTransit, delivery_status: 'notfound', substatus: 'notfound002', latest_event: null, latest_checkpoint_time: null, scheduled_delivery_date: null, origin_info: { trackinfo: [] }, destination_info: null };
    const now = new Date('2026-10-15T00:00:00Z');
    const r = parseTrackingMoreTracking(empty, { registeredAt: '2026-10-14T08:00:00Z', now });
    expect(r).toMatchObject({ status: null, events: [], registrationState: 'awaiting_data' });
    expect(parseTrackingMoreTracking({ ...empty, delivery_status: 'pending' }, { registeredAt: '2026-10-14T08:00:00Z', now }).registrationState).toBe('awaiting_data');
    // Long after registration with still nothing: unavailable.
    expect(registrationStateFor('notfound', false, '2026-09-01T00:00:00Z', now)).toBe('unavailable');
    expect(registrationStateFor('expired', true, '2026-09-01T00:00:00Z', now)).toBe('expired');
  });

  it('removes the same checkpoint listed in both legs', () => {
    const dup = { ...inTransit, destination_info: { trackinfo: [inTransit.origin_info!.trackinfo![0]] } };
    expect(parseTrackingMoreTracking(dup).events).toHaveLength(2);
  });
});

// ─── Provider ─────────────────────────────────────────────────────────────────────────────────────

describe('TrackingMore provider', () => {
  const req = (n: string, courierCode: string, registrationId: number) => ({
    trackingNumber: n,
    carrier: 'Forwarder',
    mode: 'freight' as const,
    shipDate: null,
    key: `reg:${registrationId}`,
    provider: 'trackingmore',
    courierCode,
    registrationId,
  });

  it('only handles registered identities', () => {
    const p = trackingMoreProvider(mockApi(() => ({ json: ok([]) })).client);
    expect(p.supports(req('A', 'dsv', 1))).toBe(true);
    expect(p.supports({ trackingNumber: 'A', carrier: 'DSV', mode: null, shipDate: null })).toBe(false);
  });

  it('queries per courier and keeps the same number apart for different couriers', async () => {
    const { calls, client } = mockApi((_m, _p, url) => {
      const courier = url.searchParams.get('courier_code');
      return { json: ok([{ ...inTransit, tracking_number: '1234567890', courier_code: courier, delivery_status: courier === 'dhl' ? 'delivered' : 'transit', destination_info: courier === 'dhl' ? { milestone_date: { delivery_date: '2026-10-19T10:00:00+02:00' }, trackinfo: [] } : inTransit.destination_info }]) };
    });
    const results = await trackingMoreProvider(client).track([req('1234567890', 'dhl', 1), req('1234567890', 'dsv', 2)]);
    expect(calls.map((c) => c.url.searchParams.get('courier_code'))).toEqual(['dhl', 'dsv']);
    expect(results.map((r) => [r.key, r.status])).toEqual([
      ['reg:1', 'delivered'],
      ['reg:2', 'in_transit'],
    ]);
  });

  it('returns the results fetched before a rate limit', async () => {
    let n = 0;
    const { client } = mockApi(() => (++n === 1 ? { json: ok([{ ...inTransit, tracking_number: 'A', courier_code: 'dsv' }]) } : { status: 429, json: meta(429, 'Too many requests') }));
    const err = await trackingMoreProvider(client).track([req('A', 'dsv', 1), req('B', 'ups', 2)]).catch((e) => e);
    expect(err).toBeInstanceOf(TrackingRateLimitError);
    expect(err.partial.map((r: { key: string }) => r.key)).toEqual(['reg:1']);
  });
});
