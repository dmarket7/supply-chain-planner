import { beforeEach, describe, expect, it } from 'vitest';
import {
  FedExAuthError,
  clearFedExTokenCache,
  fedexProvider,
  fedexStatus,
  parseFedExTrackResult,
  pickTrackResult,
  type FedExTrackResult,
} from '../server/tracking/fedex';
import { TrackingRateLimitError, type TrackingRequest } from '../server/tracking/provider';
import { applyTrackingResult } from '../server/tracking/apply';

/** Shaped like the Track API's documented response (TrackResult). */
const delivered: FedExTrackResult = {
  trackingNumberInfo: { trackingNumber: '878196053414' },
  latestStatusDetail: { code: 'DL', derivedCode: 'DL', description: 'Delivered', statusByLocale: 'Delivered' },
  dateAndTimes: [
    { type: 'ACTUAL_DELIVERY', dateTime: '2026-10-08T21:30:00-07:00' },
    { type: 'ACTUAL_PICKUP', dateTime: '2026-10-05T10:00:00+08:00' },
  ],
  scanEvents: [
    { date: '2026-10-08T21:30:00-07:00', eventType: 'DL', derivedStatusCode: 'DL', eventDescription: 'Delivered', scanLocation: { city: 'FREMONT', stateOrProvinceCode: 'CA', countryCode: 'US' } },
    { date: '2026-10-08T07:00:00-07:00', eventType: 'OD', derivedStatusCode: 'OD', eventDescription: 'On FedEx vehicle for delivery' },
    { date: '2026-10-06T03:00:00+08:00', eventType: 'IT', eventDescription: 'In transit', scanLocation: { city: 'TAIPEI', countryCode: 'TW' } },
    { eventType: 'PU', eventDescription: 'No date' },
  ],
};

const inTransit: FedExTrackResult = {
  latestStatusDetail: { code: 'IT', description: 'In transit' },
  dateAndTimes: [{ type: 'SHIP', dateTime: '2026-10-14T00:00:00' }],
  estimatedDeliveryTimeWindow: { type: 'ESTIMATED_DELIVERY', window: { begins: '2026-10-21T08:00:00', ends: '2026-10-21T20:00:00' } },
  scanEvents: [{ date: '2026-10-15T09:00:00+08:00', eventType: 'AR', eventDescription: 'Arrived at FedEx location' }],
};

describe('FedEx statuses', () => {
  it.each([
    ['OC', 'pending'],
    ['PU', 'in_transit'],
    ['IT', 'in_transit'],
    ['OD', 'out_for_delivery'],
    ['DL', 'delivered'],
    ['DE', 'exception'],
    ['RS', 'exception'],
    ['ZZ', 'unknown'],
    [undefined, null],
  ])('%s -> %s', (code, status) => {
    expect(fedexStatus(code)).toBe(status);
  });
});

describe('parseFedExTrackResult', () => {
  it('maps a delivered shipment, keeping the local delivery date', () => {
    const r = parseFedExTrackResult('878196053414', delivered);
    expect(r).toMatchObject({ status: 'delivered', carrier: 'FedEx', deliveredAt: '2026-10-08T21:30:00-07:00', estimatedArrivalDate: undefined });
    // 21:30 in California is already Oct 9 in UTC; the arrival date must stay Oct 8.
    const line = { id: 1, status: 'in_transit' as const, shipDate: '2026-10-05', actualArrivalDate: null, arrivalSource: null };
    expect(applyTrackingResult(line, r)).toMatchObject({ actualArrivalDate: '2026-10-08', arrivalSource: 'tracking' });
    expect(r.events.map((e) => [e.status, e.location])).toEqual([
      ['delivered', 'FREMONT, CA, US'],
      ['out_for_delivery', undefined],
      ['in_transit', 'TAIPEI, TW'],
    ]);
  });

  it('takes the estimated delivery window for a shipment on its way', () => {
    expect(parseFedExTrackResult('X', inTransit)).toMatchObject({ status: 'in_transit', estimatedArrivalDate: '2026-10-21', deliveredAt: undefined });
  });

  it('picks the shipment closest to the line ship date when a number was reused', () => {
    const old = { ...delivered, dateAndTimes: [{ type: 'SHIP', dateTime: '2025-03-01T00:00:00' }] };
    expect(pickTrackResult([old, inTransit], '2026-10-13')).toBe(inTransit);
    expect(pickTrackResult([inTransit, old], null)).toBe(inTransit);
    expect(pickTrackResult([{ error: { code: 'TRACKING.TRACKINGNUMBER.NOTFOUND' } }], null)).toBeUndefined();
  });
});

describe('fedexProvider', () => {
  beforeEach(() => clearFedExTokenCache());

  const req = (trackingNumber: string, shipDate: string | null = null): TrackingRequest => ({ trackingNumber, carrier: 'FedEx', mode: 'parcel', shipDate });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const tokenOk = () => json({ access_token: 'tok', token_type: 'bearer', expires_in: 3599 });
  const trackResponse = (numbers: string[]) =>
    json({
      output: {
        completeTrackResults: numbers.map((n) => ({
          trackingNumber: n,
          trackResults: [n.startsWith('0') ? { error: { code: 'TRACKING.TRACKINGNUMBER.NOTFOUND', message: 'not found' } } : inTransit],
        })),
      },
    });

  function fakeFedEx(handler?: (url: string, init: RequestInit, n: number) => Response | undefined) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const custom = handler?.(url, init, calls.length);
      if (custom) return custom;
      if (url.endsWith('/oauth/token')) return tokenOk();
      const body = JSON.parse(String(init.body)) as { trackingInfo: { trackingNumberInfo: { trackingNumber: string } }[] };
      return trackResponse(body.trackingInfo.map((t) => t.trackingNumberInfo.trackingNumber));
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const config = { clientId: 'id', clientSecret: 'secret', environment: 'sandbox' as const };

  it('signs in, then tracks numbers with a ship-date window', async () => {
    const { calls, fetchImpl } = fakeFedEx();
    const results = await fedexProvider(config, fetchImpl).track([req('878196053414', '2026-10-14'), req('012345678901')]);
    expect(calls[0].url).toBe('https://apis-sandbox.fedex.com/oauth/token');
    expect(String(calls[0].init.body)).toBe('grant_type=client_credentials&client_id=id&client_secret=secret');
    expect(calls[1].url).toBe('https://apis-sandbox.fedex.com/track/v1/trackingnumbers');
    expect(new Headers(calls[1].init.headers).get('Authorization')).toBe('Bearer tok');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      includeDetailedScans: true,
      trackingInfo: [
        { trackingNumberInfo: { trackingNumber: '878196053414' }, shipDateBegin: '2026-09-14', shipDateEnd: '2026-11-13' },
        { trackingNumberInfo: { trackingNumber: '012345678901' } },
      ],
    });
    // The unknown number is left out, so refresh records it as "not found".
    expect(results.map((r) => r.trackingNumber)).toEqual(['878196053414']);
  });

  it('sends at most 30 numbers per call and reuses the token', async () => {
    const { calls, fetchImpl } = fakeFedEx();
    const numbers = Array.from({ length: 31 }, (_, i) => req(String(100000000000 + i)));
    const provider = fedexProvider(config, fetchImpl);
    expect(await provider.track(numbers)).toHaveLength(31);
    await provider.track([req('999999999999')]);
    expect(calls.map((c) => c.url.split('.com')[1])).toEqual(['/oauth/token', '/track/v1/trackingnumbers', '/track/v1/trackingnumbers', '/track/v1/trackingnumbers']);
  });

  it('signs in again once when the token is rejected', async () => {
    const { calls, fetchImpl } = fakeFedEx((_url, _init, n) => (n === 2 ? json({ errors: [{ code: 'NOT.AUTHORIZED.ERROR' }] }, 401) : undefined));
    expect(await fedexProvider(config, fetchImpl).track([req('878196053414')])).toHaveLength(1);
    expect(calls.map((c) => c.url.split('.com')[1])).toEqual(['/oauth/token', '/track/v1/trackingnumbers', '/oauth/token', '/track/v1/trackingnumbers']);
  });

  it('treats a top-level "not found" as no results, not a failure', async () => {
    const { fetchImpl } = fakeFedEx((url) =>
      url.endsWith('/trackingnumbers') ? json({ errors: [{ code: 'TRACKING.TRACKINGNUMBER.NOTFOUND', message: 'Tracking number cannot be found.' }] }, 404) : undefined,
    );
    expect(await fedexProvider(config, fetchImpl).track([req('012345678901')])).toEqual([]);
  });

  it('reports rate limiting with the results fetched so far', async () => {
    const { fetchImpl } = fakeFedEx((_url, _init, n) => (n === 3 ? new Response('{}', { status: 429, headers: { 'retry-after': '20' } }) : undefined));
    const numbers = Array.from({ length: 40 }, (_, i) => req(String(100000000000 + i)));
    const err = await fedexProvider(config, fetchImpl).track(numbers).catch((e) => e);
    expect(err).toBeInstanceOf(TrackingRateLimitError);
    expect(err.retryAfterSeconds).toBe(20);
    expect(err.partial).toHaveLength(30);
  });

  it('fails clearly on bad credentials', async () => {
    const { fetchImpl } = fakeFedEx((url) => (url.endsWith('/oauth/token') ? json({ errors: [{ code: 'NOT.AUTHORIZED.ERROR' }] }, 401) : undefined));
    await expect(fedexProvider(config, fetchImpl).track([req('878196053414')])).rejects.toBeInstanceOf(FedExAuthError);
  });

  it('only handles FedEx lines and uses the production host when asked', async () => {
    const { calls, fetchImpl } = fakeFedEx();
    const provider = fedexProvider({ ...config, environment: 'production' }, fetchImpl);
    expect(provider.supports(req('1'))).toBe(true);
    expect(provider.supports({ ...req('1'), carrier: 'DHL' })).toBe(false);
    await provider.track([req('878196053414')]);
    expect(calls[0].url).toBe('https://apis.fedex.com/oauth/token');
  });
});
