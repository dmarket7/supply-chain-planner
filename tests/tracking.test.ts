import { describe, expect, it } from 'vitest';
import { applyTrackingResult, type TrackedLine } from '../server/tracking/apply';
import { TrackingRateLimitError, type TrackingResult } from '../server/tracking/provider';
import { parseShip24Tracking, ship24Provider, type Ship24Tracking } from '../server/tracking/ship24';

/** Trimmed from the `tracking` example in Ship24's OpenAPI spec. */
const delivered: Ship24Tracking = {
  tracker: { trackingNumber: '9400115901047177598206' },
  shipment: {
    statusMilestone: 'delivered',
    delivery: { estimatedDeliveryDate: '2021-03-04T18:00:00', courierEstimatedDeliveryDate: { from: '2021-03-04T17:00:00', to: null } },
  },
  events: [
    { status: 'Delivered to the addressee', occurrenceDatetime: '2021-03-04T17:12:57', location: 'SAN RAFAEL, CA 94901', courierCode: 'us-post', statusMilestone: 'delivered' },
    { status: 'Out for delivery', occurrenceDatetime: '2021-03-04T07:00:00', datetime: '2021-03-04T15:00:00.000Z', statusMilestone: 'out_for_delivery' },
    { status: 'No date', occurrenceDatetime: null },
  ],
  statistics: { timestamps: { deliveredDatetime: '2021-03-04T17:12:57' } },
};

describe('parseShip24Tracking', () => {
  it('maps milestone, ETA, delivery and events', () => {
    const r = parseShip24Tracking('9400115901047177598206', delivered);
    expect(r).toMatchObject({
      status: 'delivered',
      estimatedArrivalDate: '2021-03-04',
      deliveredAt: '2021-03-04T17:12:57.000Z',
      carrier: 'us-post',
    });
    expect(r.events.map((e) => [e.status, e.occurredAt])).toEqual([
      ['delivered', '2021-03-04T17:12:57.000Z'],
      ['out_for_delivery', '2021-03-04T15:00:00.000Z'], // prefers the UTC `datetime`
    ]);
  });

  it('treats a pending tracker as "no information yet"', () => {
    expect(parseShip24Tracking('X', { shipment: { statusMilestone: 'pending' }, events: [] })).toMatchObject({ status: null, events: [] });
    expect(parseShip24Tracking('X', { shipment: { statusMilestone: 'failed_attempt' } }).status).toBe('exception');
    expect(parseShip24Tracking('X', { shipment: { statusMilestone: 'something_new' } }).status).toBe('unknown');
  });
});

describe('ship24Provider', () => {
  const ok = (t: Ship24Tracking) => new Response(JSON.stringify({ data: { trackings: [t] } }), { status: 200 });

  it('posts each number with the ship date and parses the result', async () => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('Authorization') });
      return ok(delivered);
    }) as typeof fetch;
    const results = await ship24Provider('key123', fake).track([
      { trackingNumber: '878196053414', carrier: 'FedEx', mode: 'parcel', shipDate: '2026-10-05' },
    ]);
    expect(calls).toEqual([
      {
        url: 'https://api.ship24.com/public/v1/trackers/track',
        body: { trackingNumber: '878196053414', shippingDate: '2026-10-05T00:00:00.000Z' },
        auth: 'Bearer key123',
      },
    ]);
    expect(results[0]).toMatchObject({ trackingNumber: '878196053414', status: 'delivered' });
  });

  it('returns partial results when rate limited', async () => {
    let n = 0;
    const fake = (async () => (++n === 2 ? new Response('{}', { status: 429, headers: { 'retry-after': '30' } }) : ok(delivered))) as typeof fetch;
    const reqs = ['A', 'B', 'C'].map((trackingNumber) => ({ trackingNumber, carrier: null, mode: null, shipDate: null }));
    const err = await ship24Provider('k', fake).track(reqs).catch((e) => e);
    expect(err).toBeInstanceOf(TrackingRateLimitError);
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.partial.map((r: TrackingResult) => r.trackingNumber)).toEqual(['A', 'C']);
  });

  it('fails loudly on a bad API key', async () => {
    const fake = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    await expect(ship24Provider('bad', fake).track([{ trackingNumber: 'A', carrier: null, mode: null, shipDate: null }])).rejects.toThrow(
      /rejected the API key/,
    );
  });
});

describe('applyTrackingResult', () => {
  const line = (over: Partial<TrackedLine> = {}): TrackedLine => ({
    id: 1,
    status: 'in_transit',
    shipDate: '2026-10-05',
    actualArrivalDate: null,
    arrivalSource: null,
    ...over,
  });
  const result = (over: Partial<TrackingResult> = {}): TrackingResult => ({ trackingNumber: 'T', status: 'in_transit', events: [], ...over });

  it('updates progress and ETA for a line in transit', () => {
    expect(applyTrackingResult(line(), result({ status: 'out_for_delivery', estimatedArrivalDate: '2026-10-09' }))).toMatchObject({
      status: 'out_for_delivery',
      estimatedArrivalDate: '2026-10-09',
      actualArrivalDate: null,
      confirmedArrival: false,
    });
  });

  it('keeps the current status when the provider has nothing yet', () => {
    expect(applyTrackingResult(line({ status: 'pending' }), result({ status: null })).status).toBe('pending');
  });

  it('confirms delivery and replaces a report estimate', () => {
    const estimated = line({ status: 'delivered', actualArrivalDate: '2026-10-10', arrivalSource: 'report_window' });
    expect(applyTrackingResult(estimated, result({ status: 'delivered', deliveredAt: '2026-10-08T14:00:00.000Z' }))).toMatchObject({
      status: 'delivered',
      actualArrivalDate: '2026-10-08',
      arrivalSource: 'tracking',
      confirmedArrival: true,
    });
  });

  it('never overrides a date entered by hand', () => {
    const manual = line({ status: 'delivered', actualArrivalDate: '2026-10-07', arrivalSource: 'manual' });
    expect(applyTrackingResult(manual, result({ status: 'delivered', deliveredAt: '2026-10-08T00:00:00Z' }))).toMatchObject({
      actualArrivalDate: '2026-10-07',
      arrivalSource: 'manual',
      confirmedArrival: false,
    });
  });

  it('ignores a delivery before the line shipped (reused tracking number)', () => {
    const r = applyTrackingResult(line(), result({ status: 'delivered', deliveredAt: '2025-06-01T00:00:00Z' }));
    expect(r).toMatchObject({ status: 'in_transit', actualArrivalDate: null, confirmedArrival: false });
    expect(r.ignoredDelivery).toMatch(/reused tracking number/);
  });
});
