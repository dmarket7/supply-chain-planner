import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../server/db/client';
import { providerTrackings, shipments, trackingEvents } from '../server/db/schema';
import { TrackingRateLimitError, type TrackingProvider, type TrackingResult } from '../server/tracking/provider';
import { eventKey, refreshTracking } from '../server/tracking/refresh';
import { TrackingMoreError, type TrackingMoreClient, type TrackingMoreTracking } from '../server/tracking/trackingmore/client';
import { trackingMoreProvider } from '../server/tracking/trackingmore/provider';
import { createTestDb, seedShipments } from './helpers/testDb';

const NOW = new Date('2026-10-20T12:00:00Z');

/** A TrackingMore API double: answers /trackings/get from a table keyed by courier + number. */
function fakeTrackingMore(data: Map<string, TrackingMoreTracking>, opts: { fail?: Error } = {}) {
  const calls: { courier?: string; numbers: string[] }[] = [];
  const client: TrackingMoreClient = {
    listCouriers: async () => [],
    detectCouriers: async () => [],
    createTracking: async () => ({ outcome: 'exists' }),
    batchCreate: async () => ({ success: [], error: [] }),
    getTrackings: async ({ trackingNumbers, courierCode }) => {
      calls.push({ courier: courierCode, numbers: trackingNumbers });
      if (opts.fail) throw opts.fail;
      return trackingNumbers.map((n) => data.get(`${courierCode}|${n}`)).filter((t): t is TrackingMoreTracking => !!t);
    },
  };
  return { client, calls };
}

const checkpoint = (date: string, status: string, detail: string, location: string | null = null) => ({
  checkpoint_date: date,
  checkpoint_delivery_status: status,
  checkpoint_delivery_substatus: null,
  tracking_detail: detail,
  location,
  country_iso2: null,
  state: null,
  city: null,
  zip: null,
  raw_status: null,
});

function tracking(number: string, courier: string, over: Partial<TrackingMoreTracking> = {}): TrackingMoreTracking {
  return {
    id: `tm-${courier}-${number}`,
    tracking_number: number,
    courier_code: courier,
    created_at: '2026-10-14T00:00:00+00:00',
    update_at: null,
    delivery_status: 'transit',
    substatus: 'transit001',
    status_info: null,
    latest_event: 'Departed',
    latest_checkpoint_time: '2026-10-16T03:00:00+08:00',
    scheduled_delivery_date: '2026-10-22',
    archived: null,
    updating: null,
    origin_info: { trackinfo: [checkpoint('2026-10-16T03:00:00+08:00', 'transit', 'Departed', 'Hong Kong'), checkpoint('2026-10-14 10:00', 'transit', 'Picked up', 'Taipei')] },
    destination_info: null,
    ...over,
  };
}

describe('refresh with TrackingMore registrations', () => {
  let db: Db;
  beforeEach(async () => {
    ({ db } = await createTestDb());
  }, 30000);

  async function registration(courierCode: string, trackingNumber: string, episodeKey = '2026-10-14', state: 'awaiting_data' | 'active' | 'expired' = 'awaiting_data') {
    const [r] = await db
      .insert(providerTrackings)
      .values({ provider: 'trackingmore', courierCode, trackingNumber, episodeKey, anchorShipDate: episodeKey === 'none' ? null : episodeKey, state, registeredAt: new Date('2026-10-14T00:00:00Z') })
      .returning({ id: providerTrackings.id });
    return r.id;
  }
  const lineRows = () => db.select().from(shipments).orderBy(asc(shipments.id));
  const events = (shipmentId: number) => db.select().from(trackingEvents).where(eq(trackingEvents.shipmentId, shipmentId));

  it('updates every PO line sharing a tracking identity, with events and registration state', async () => {
    const reg = await registration('dsv', 'CWF1');
    const [a, b] = await seedShipments(db, [
      { carrier: 'Forwarder', trackingNumber: 'CWF1', shipDate: '2026-10-14', promisedArrivalDate: '2026-10-25', trackingRegistrationId: reg },
      { carrier: 'Forwarder', trackingNumber: 'CWF1', shipDate: '2026-10-14', promisedArrivalDate: '2026-10-25', trackingRegistrationId: reg },
    ]);
    const { client, calls } = fakeTrackingMore(new Map([['dsv|CWF1', tracking('CWF1', 'dsv')]]));
    const r = await refreshTracking(db, [trackingMoreProvider(client)], { scope: 'open' }, NOW);
    expect(r).toMatchObject({ checked: 1, found: 1, linesUpdated: 2, linesChanged: 2, remaining: 0 });
    expect(calls).toEqual([{ courier: 'dsv', numbers: ['CWF1'] }]);
    const lines = await lineRows();
    for (const l of lines) {
      expect(l).toMatchObject({ status: 'in_transit', estimatedArrivalDate: '2026-10-22', promisedArrivalDate: '2026-10-25', trackingProvider: 'trackingmore', trackingFound: true });
    }
    expect(await events(a)).toHaveLength(2);
    expect(await events(b)).toHaveLength(2);
    const [row] = await db.select().from(providerTrackings);
    expect(row).toMatchObject({ state: 'active', lastProviderStatus: 'transit', lastProviderSubstatus: 'transit001', externalId: 'tm-dsv-CWF1', lastError: null });
    expect(row.lastSuccessAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('is idempotent: an unchanged sync adds no events and counts no changes', async () => {
    const reg = await registration('dsv', 'CWF1');
    const [a] = await seedShipments(db, [{ carrier: 'Forwarder', trackingNumber: 'CWF1', shipDate: '2026-10-14', trackingRegistrationId: reg }]);
    const { client } = fakeTrackingMore(new Map([['dsv|CWF1', tracking('CWF1', 'dsv')]]));
    await refreshTracking(db, [trackingMoreProvider(client)], { scope: 'open' }, NOW);
    const again = await refreshTracking(db, [trackingMoreProvider(client)], { scope: 'open', force: true }, new Date(NOW.getTime() + 60_000));
    expect(again).toMatchObject({ checked: 1, found: 1, linesUpdated: 1, linesChanged: 0 });
    expect(await events(a)).toHaveLength(2);
  });

  it('stores late, older scans once without moving the latest scan time backwards', async () => {
    const reg = await registration('dsv', 'CWF1');
    const [a] = await seedShipments(db, [{ carrier: 'Forwarder', trackingNumber: 'CWF1', shipDate: '2026-10-14', trackingRegistrationId: reg }]);
    const data = new Map([['dsv|CWF1', tracking('CWF1', 'dsv')]]);
    const { client } = fakeTrackingMore(data);
    await refreshTracking(db, [trackingMoreProvider(client)], { scope: 'open' }, NOW);
    const before = (await lineRows())[0].lastEventAt?.toISOString();
    // The provider now also returns an older scan it had missed, plus the same two again (a duplicate).
    data.set('dsv|CWF1', tracking('CWF1', 'dsv', { origin_info: { trackinfo: [...tracking('CWF1', 'dsv').origin_info!.trackinfo!, checkpoint('2026-10-13 18:00', 'inforeceived', 'Booking received')] } }));
    const r = await refreshTracking(db, [trackingMoreProvider(client)], { scope: 'open', force: true }, new Date(NOW.getTime() + 60_000));
    expect(r.linesChanged).toBe(0);
    expect(await events(a)).toHaveLength(3);
    expect((await lineRows())[0].lastEventAt?.toISOString()).toBe(before);
  });

  it('keeps the same number under different couriers apart', async () => {
    const dhl = await registration('dhl', '1234567890');
    const ups = await registration('ups', '1234567890');
    await seedShipments(db, [
      { carrier: 'DHL', trackingNumber: '1234567890', shipDate: '2026-10-14', trackingRegistrationId: dhl },
      { carrier: 'UPS', trackingNumber: '1234567890', shipDate: '2026-10-14', trackingRegistrationId: ups },
    ]);
    const delivered = tracking('1234567890', 'dhl', {
      delivery_status: 'delivered',
      destination_info: { milestone_date: { delivery_date: '2026-10-18T10:00:00+02:00' }, trackinfo: [] },
    });
    const { client } = fakeTrackingMore(new Map([['dhl|1234567890', delivered], ['ups|1234567890', tracking('1234567890', 'ups')]]));
    expect(await refreshTracking(db, [trackingMoreProvider(client)], { scope: 'open' }, NOW)).toMatchObject({ checked: 2, arrivalsConfirmed: 1 });
    const [dhlLine, upsLine] = await lineRows();
    expect(dhlLine).toMatchObject({ status: 'delivered', actualArrivalDate: '2026-10-18', arrivalSource: 'tracking' });
    expect(upsLine).toMatchObject({ status: 'in_transit', actualArrivalDate: null });
  });

  it('ignores a delivery dated before the line shipped (recycled number)', async () => {
    const reg = await registration('dhl', '5550001111', '2026-10-10');
    await seedShipments(db, [{ carrier: 'DHL', trackingNumber: '5550001111', shipDate: '2026-10-10', trackingRegistrationId: reg }]);
    const old = tracking('5550001111', 'dhl', { delivery_status: 'delivered', destination_info: { milestone_date: { delivery_date: '2026-03-02T09:00:00+00:00' }, trackinfo: [] } });
    const { client } = fakeTrackingMore(new Map([['dhl|5550001111', old]]));
    expect(await refreshTracking(db, [trackingMoreProvider(client)], { scope: 'open' }, NOW)).toMatchObject({ ignoredDeliveries: 1, arrivalsConfirmed: 0 });
    expect((await lineRows())[0]).toMatchObject({ actualArrivalDate: null });
    expect((await db.select().from(providerTrackings))[0].lastWarning).toMatch(/reused tracking number/);
  });

  it('never overrides a manual arrival date', async () => {
    const reg = await registration('dsv', 'CWF1');
    await seedShipments(db, [
      { carrier: 'Forwarder', trackingNumber: 'CWF1', shipDate: '2026-10-14', trackingRegistrationId: reg, actualArrivalDate: '2026-10-19', arrivalSource: 'manual', status: 'delivered' },
    ]);
    const delivered = tracking('CWF1', 'dsv', { delivery_status: 'delivered', destination_info: { milestone_date: { delivery_date: '2026-10-17T08:00:00+08:00' }, trackinfo: [] } });
    const { client } = fakeTrackingMore(new Map([['dsv|CWF1', delivered]]));
    await refreshTracking(db, [trackingMoreProvider(client)], { scope: 'line', shipmentIds: (await lineRows()).map((l) => l.id) }, NOW);
    expect((await lineRows())[0]).toMatchObject({ actualArrivalDate: '2026-10-19', arrivalSource: 'manual' });
  });

  it('shows "awaiting data" for a registered number with no scans yet, without marking it not found', async () => {
    const reg = await registration('dsv', 'CWF9');
    await seedShipments(db, [{ carrier: 'Forwarder', trackingNumber: 'CWF9', shipDate: '2026-10-14', trackingRegistrationId: reg }]);
    const empty = tracking('CWF9', 'dsv', { delivery_status: 'notfound', substatus: 'notfound002', latest_event: null, latest_checkpoint_time: null, scheduled_delivery_date: null, origin_info: { trackinfo: [] } });
    const { client } = fakeTrackingMore(new Map([['dsv|CWF9', empty]]));
    await refreshTracking(db, [trackingMoreProvider(client)], { scope: 'open' }, new Date('2026-10-15T00:00:00Z'));
    expect((await lineRows())[0]).toMatchObject({ status: 'in_transit', trackingFound: null });
    expect((await db.select().from(providerTrackings))[0]).toMatchObject({ state: 'awaiting_data', lastProviderStatus: 'notfound' });
  });

  it('keeps tracking data when TrackingMore fails, and records the error on the registration', async () => {
    const reg = await registration('dsv', 'CWF1');
    const [a] = await seedShipments(db, [{ carrier: 'Forwarder', trackingNumber: 'CWF1', shipDate: '2026-10-14', trackingRegistrationId: reg }]);
    await refreshTracking(db, [trackingMoreProvider(fakeTrackingMore(new Map([['dsv|CWF1', tracking('CWF1', 'dsv')]])).client)], { scope: 'open' }, NOW);
    const failing = fakeTrackingMore(new Map(), { fail: new TrackingMoreError('TrackingMore tracking retrieval failed: Server error (511)', 511, 500) });
    await expect(refreshTracking(db, [trackingMoreProvider(failing.client)], { scope: 'open', force: true }, new Date(NOW.getTime() + 60_000))).rejects.toThrow(/511/);
    expect((await lineRows())[0]).toMatchObject({ status: 'in_transit', estimatedArrivalDate: '2026-10-22', trackingFound: true });
    expect(await events(a)).toHaveLength(2);
    expect((await db.select().from(providerTrackings))[0]).toMatchObject({ state: 'active', lastError: expect.stringMatching(/511/) });
  });

  it('marks a registration missing when TrackingMore no longer has it', async () => {
    const reg = await registration('dsv', 'GONE1');
    await seedShipments(db, [{ carrier: 'Forwarder', trackingNumber: 'GONE1', shipDate: '2026-10-14', trackingRegistrationId: reg }]);
    const { client } = fakeTrackingMore(new Map());
    expect(await refreshTracking(db, [trackingMoreProvider(client)], { scope: 'open' }, NOW)).toMatchObject({ checked: 1, notFound: 1 });
    expect((await db.select().from(providerTrackings))[0]).toMatchObject({ state: 'missing', lastError: expect.stringMatching(/register it again/) });
  });

  it('skips expired registrations and unregistered lines of carriers without a provider', async () => {
    const reg = await registration('dsv', 'OLD1', '2026-06-01', 'expired');
    await seedShipments(db, [
      { carrier: 'Forwarder', trackingNumber: 'OLD1', trackingRegistrationId: reg },
      { carrier: 'Sinotrans', trackingNumber: 'S1' },
    ]);
    const { client, calls } = fakeTrackingMore(new Map());
    expect(await refreshTracking(db, [trackingMoreProvider(client)], { scope: 'open' }, NOW)).toMatchObject({ checked: 0 });
    expect(calls).toEqual([]);
  });

  it('keeps FedEx on the direct API and never sends the same identity to two providers', async () => {
    const reg = await registration('fedex', '878196053414');
    await seedShipments(db, [
      { carrier: 'FedEx', trackingNumber: '111111111111', shipDate: '2026-10-14' },
      { carrier: 'FedEx', trackingNumber: '878196053414', shipDate: '2026-10-14', trackingRegistrationId: reg, courierOverride: 'fedex' },
    ]);
    const fedexCalls: string[] = [];
    const fedex: TrackingProvider = {
      name: 'fedex',
      kind: 'direct',
      carriers: ['FedEx'],
      supports: (r) => r.carrier === 'FedEx' && !r.registrationId,
      track: async (reqs) => {
        fedexCalls.push(...reqs.map((r) => r.trackingNumber));
        return reqs.map((r): TrackingResult => ({ trackingNumber: r.trackingNumber, status: 'out_for_delivery', events: [] }));
      },
    };
    const tm = fakeTrackingMore(new Map([['fedex|878196053414', tracking('878196053414', 'fedex')]]));
    expect(await refreshTracking(db, [fedex, trackingMoreProvider(tm.client)], { scope: 'open' }, NOW)).toMatchObject({ checked: 2, found: 2 });
    expect(fedexCalls).toEqual(['111111111111']);
    expect(tm.calls.flatMap((c) => c.numbers)).toEqual(['878196053414']);
    const [direct, viaTm] = await lineRows();
    expect(direct).toMatchObject({ status: 'out_for_delivery', trackingProvider: 'fedex' });
    expect(viaTm).toMatchObject({ status: 'in_transit', trackingProvider: 'trackingmore' });
  });

  it('pauses on a rate limit and saves what was fetched', async () => {
    const r1 = await registration('dsv', 'A1');
    const r2 = await registration('ups', 'B1');
    await seedShipments(db, [
      { carrier: 'DSV', trackingNumber: 'A1', shipDate: '2026-10-14', trackingRegistrationId: r1 },
      { carrier: 'UPS', trackingNumber: 'B1', shipDate: '2026-10-14', trackingRegistrationId: r2 },
    ]);
    let n = 0;
    const client: TrackingMoreClient = {
      ...fakeTrackingMore(new Map()).client,
      getTrackings: async ({ trackingNumbers, courierCode }) => {
        if (++n === 2) throw new TrackingRateLimitError(30);
        return [tracking(trackingNumbers[0], courierCode!)];
      },
    };
    const r = await refreshTracking(db, [trackingMoreProvider(client)], { scope: 'open' }, NOW);
    expect(r).toMatchObject({ rateLimited: true, retryAfterSeconds: 30, checked: 1, found: 1, remaining: 1 });
  });

  it('builds stable event keys', () => {
    const e = { occurredAt: '2026-10-16T03:00:00.000Z', status: 'in_transit' as const, description: 'Departed', location: 'Hong Kong' };
    expect(eventKey(e)).toBe(eventKey({ ...e, description: ' departed ' }));
    expect(eventKey(e)).not.toBe(eventKey({ ...e, location: 'Taipei' }));
  });
});
