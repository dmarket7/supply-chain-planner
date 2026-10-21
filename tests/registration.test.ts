import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../server/db/client';
import { carrierMappings, providerCouriers, providerTrackings, shipments } from '../server/db/schema';
import { alreadyExistsOutcome, planRegistrations, registerIdentities, type ExistingRegistration } from '../server/tracking/registration';
import { planForScope } from '../server/tracking/routing';
import { TrackingMoreAuthError, TrackingMoreQuotaError, type TrackingMoreClient } from '../server/tracking/trackingmore/client';
import { trackingMoreProvider } from '../server/tracking/trackingmore/provider';
import { createTestDb, seedShipments } from './helpers/testDb';

const line = (id: number, trackingNumber: string, courierCode: string, shipDate: string | null, registrationId: number | null = null) => ({
  id,
  trackingNumber,
  courierCode,
  shipDate,
  registrationId,
});
const reg = (over: Partial<ExistingRegistration>): ExistingRegistration => ({
  id: 1,
  courierCode: 'dsv',
  trackingNumber: 'CWF1',
  episodeKey: '2026-10-01',
  anchorShipDate: '2026-10-01',
  state: 'active',
  claimedAt: null,
  ...over,
});

describe('planRegistrations', () => {
  it('registers one identity for PO lines sharing a number', () => {
    const plan = planRegistrations([line(1, 'CWF1', 'dsv', '2026-10-02'), line(2, 'CWF1', 'dsv', '2026-10-01')], []);
    expect(plan).toEqual([expect.objectContaining({ trackingNumber: 'CWF1', courierCode: 'dsv', episodeKey: '2026-10-01', lineIds: [2, 1], action: 'submit' })]);
  });

  it('keeps the same number apart for different couriers', () => {
    const plan = planRegistrations([line(1, '1234567890', 'dhl', '2026-10-02'), line(2, '1234567890', 'ups', '2026-10-02')], []);
    expect(plan.map((p) => [p.courierCode, p.lineIds])).toEqual([
      ['dhl', [1]],
      ['ups', [2]],
    ]);
  });

  it('starts a new episode when a number is reused months later', () => {
    const plan = planRegistrations([line(1, 'N1', 'dhl', '2026-01-05'), line(2, 'N1', 'dhl', '2026-09-20'), line(3, 'N1', 'dhl', '2026-01-09')], []);
    expect(plan.map((p) => [p.episodeKey, p.lineIds])).toEqual([
      ['2026-01-05', [1, 3]],
      ['2026-09-20', [2]],
    ]);
  });

  it('links new lines to an existing registration for free, and leaves linked ones alone', () => {
    const existing = [reg({ id: 7 })];
    expect(planRegistrations([line(1, 'CWF1', 'dsv', '2026-10-03', 7)], existing)[0].action).toBe('none');
    const plan = planRegistrations([line(1, 'CWF1', 'dsv', '2026-10-03', 7), line(2, 'CWF1', 'dsv', null)], existing);
    expect(plan).toEqual([expect.objectContaining({ action: 'link', lineIds: [1, 2], existing: expect.objectContaining({ id: 7 }) })]);
  });

  it('resubmits failed registrations and abandoned claims, but not fresh claims', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const lines = [line(1, 'CWF1', 'dsv', '2026-10-03', 7)];
    expect(planRegistrations(lines, [reg({ id: 7, state: 'register_failed' })], now)[0].action).toBe('submit');
    expect(planRegistrations(lines, [reg({ id: 7, state: 'registering', claimedAt: '2026-10-20T11:00:00Z' })], now)[0].action).toBe('submit');
    expect(planRegistrations(lines, [reg({ id: 7, state: 'registering', claimedAt: '2026-10-20T11:58:00Z' })], now)[0].action).toBe('none');
    expect(planRegistrations(lines, [reg({ id: 7, state: 'invalid' })], now)[0].action).toBe('none');
  });

  it('tells a harmless "already exists" from a reused number held by an older episode', () => {
    expect(alreadyExistsOutcome(2, { courierCode: 'dhl', trackingNumber: 'N1' }, [])).toMatchObject({ state: 'awaiting_data' });
    expect(alreadyExistsOutcome(2, { courierCode: 'dhl', trackingNumber: 'N1' }, [{ id: 1, courierCode: 'dhl', trackingNumber: 'N1' }])).toMatchObject({ state: 'conflict' });
  });
});

// ─── Database-level registration ────────────────────────────────────────────────────────────────

type Calls = { create: string[]; batch: string[][] };
function fakeClient(over: Partial<TrackingMoreClient> = {}): { client: TrackingMoreClient; calls: Calls } {
  const calls: Calls = { create: [], batch: [] };
  const client: TrackingMoreClient = {
    listCouriers: async () => [],
    detectCouriers: async () => [],
    getTrackings: async () => [],
    createTracking: async (p) => {
      calls.create.push(p.tracking_number);
      return { outcome: 'created', tracking: null, id: `tm-${p.tracking_number}` };
    },
    batchCreate: async (ps) => {
      calls.batch.push(ps.map((p) => p.tracking_number));
      return { success: ps.map((p) => ({ id: `tm-${p.tracking_number}`, tracking_number: p.tracking_number, courier_code: p.courier_code, errorCode: null, errorMessage: null })), error: [] };
    },
    ...over,
  };
  // Wrap overrides so calls are still recorded.
  if (over.createTracking) client.createTracking = async (p) => (calls.create.push(p.tracking_number), over.createTracking!(p));
  if (over.batchCreate) client.batchCreate = async (ps) => (calls.batch.push(ps.map((p) => p.tracking_number)), over.batchCreate!(ps));
  return { client, calls };
}

describe('registering with TrackingMore', () => {
  let db: Db;
  beforeEach(async () => {
    ({ db } = await createTestDb());
    await db.insert(providerCouriers).values([
      { provider: 'trackingmore', courierCode: 'dsv', name: 'DSV' },
      { provider: 'trackingmore', courierCode: 'dhl', name: 'DHL Express' },
    ]);
    await db.insert(carrierMappings).values([
      { provider: 'trackingmore', carrier: 'DSV', prefix: '', courierCode: 'dsv', status: 'mapped', confirmedBy: 'test' },
      { provider: 'trackingmore', carrier: 'Forwarder', prefix: 'CWF', courierCode: 'dsv', status: 'mapped', confirmedBy: 'test' },
      { provider: 'trackingmore', carrier: 'DHL', prefix: '', courierCode: 'dhl', status: 'mapped', confirmedBy: 'test' },
    ]);
  }, 30000);

  const providers = (client: TrackingMoreClient) => [trackingMoreProvider(client)];
  async function register(client: TrackingMoreClient, scope: Parameters<typeof planForScope>[2] = { scope: 'open' }) {
    const { identities } = await planForScope(db, providers(client), scope);
    return registerIdentities(db, client, 'trackingmore', identities, 'tester@example.com');
  }

  it('registers a single shipment, stores the provider id and links the line', async () => {
    const [id] = await seedShipments(db, [{ carrier: 'DSV', trackingNumber: 'DSV1', shipDate: '2026-10-10' }]);
    const { client, calls } = fakeClient();
    const preview = (await planForScope(db, providers(client), { scope: 'open' })).preview;
    expect(preview).toMatchObject({ identitiesToRegister: 1, linesToRegister: 1, unresolvedLines: 0 });

    const r = await register(client);
    expect(r).toMatchObject({ submitted: 1, registered: 1, linesLinked: 1 });
    expect(calls.create).toEqual(['DSV1']);
    const [row] = await db.select().from(providerTrackings);
    expect(row).toMatchObject({ courierCode: 'dsv', trackingNumber: 'DSV1', episodeKey: '2026-10-10', externalId: 'tm-DSV1', state: 'awaiting_data', registeredBy: 'tester@example.com' });
    const [s] = await db.select({ reg: shipments.trackingRegistrationId }).from(shipments).where(eq(shipments.id, id));
    expect(s.reg).toBe(row.id);
  });

  it('registers in bulk, one identity per shared number, and never twice', async () => {
    await seedShipments(db, [
      { carrier: 'DSV', trackingNumber: 'DSV1', shipDate: '2026-10-10' },
      { carrier: 'DSV', trackingNumber: 'DSV1', shipDate: '2026-10-11' }, // second PO line, same parcel
      { carrier: 'Forwarder', trackingNumber: 'CWF12345678901', shipDate: '2026-10-12' },
      { carrier: 'DHL', trackingNumber: '1234567890', shipDate: '2026-10-12' },
      { carrier: 'Forwarder', trackingNumber: 'PNS12345678', shipDate: '2026-10-12' }, // unmapped prefix
      { carrier: 'Truck', trackingNumber: null },
    ]);
    const { client, calls } = fakeClient();
    const preview = (await planForScope(db, providers(client), { scope: 'open' })).preview;
    expect(preview).toMatchObject({ identitiesToRegister: 3, linesToRegister: 4, unresolvedLines: 1 });
    expect(preview.unresolved).toEqual([expect.objectContaining({ key: 'Forwarder · PNS…', lines: 1 })]);

    expect(await register(client)).toMatchObject({ submitted: 3, registered: 3, linesLinked: 4 });
    expect(calls.batch).toHaveLength(1);
    expect(calls.batch[0].sort()).toEqual(['1234567890', 'CWF12345678901', 'DSV1']);

    // Clicking again: nothing to submit, no API call.
    expect(await register(client)).toMatchObject({ submitted: 0, registered: 0 });
    expect(calls.batch).toHaveLength(1);
    expect(await db.select().from(providerTrackings)).toHaveLength(3);

    // A new PO line with an already registered number is linked for free.
    await seedShipments(db, [{ carrier: 'DSV', trackingNumber: 'DSV1', shipDate: '2026-10-15' }]);
    expect((await planForScope(db, providers(client), { scope: 'open' })).preview).toMatchObject({ identitiesToRegister: 0, linesToLink: 1 });
    expect(await register(client)).toMatchObject({ submitted: 0, linesLinked: 1 });
    expect(calls.batch).toHaveLength(1);
  });

  it('sends an identity once even when two requests race', async () => {
    await seedShipments(db, [
      { carrier: 'DSV', trackingNumber: 'DSV1', shipDate: '2026-10-10' },
      { carrier: 'DSV', trackingNumber: 'DSV2', shipDate: '2026-10-10' },
    ]);
    const { client, calls } = fakeClient();
    // Both plan before either writes, as two users clicking at the same time would.
    const [a, b] = await Promise.all([planForScope(db, providers(client), { scope: 'open' }), planForScope(db, providers(client), { scope: 'open' })]);
    const [ra, rb] = await Promise.all([
      registerIdentities(db, client, 'trackingmore', a.identities, 'a'),
      registerIdentities(db, client, 'trackingmore', b.identities, 'b'),
    ]);
    expect(calls.batch.flat().sort()).toEqual(['DSV1', 'DSV2']);
    expect(ra.submitted + rb.submitted).toBe(2);
    expect(ra.inProgress + rb.inProgress).toBe(2);
    expect(await db.select().from(providerTrackings)).toHaveLength(2);
  });

  it('records per-number outcomes: already registered, invalid number', async () => {
    await seedShipments(db, [
      { carrier: 'DSV', trackingNumber: 'OK1', shipDate: '2026-10-10' },
      { carrier: 'DSV', trackingNumber: 'DUP1', shipDate: '2026-10-10' },
      { carrier: 'DSV', trackingNumber: 'BAD1', shipDate: '2026-10-10' },
    ]);
    const { client } = fakeClient({
      batchCreate: async (ps) => ({
        success: ps.filter((p) => p.tracking_number === 'OK1').map((p) => ({ id: 'x1', tracking_number: p.tracking_number, courier_code: 'dsv', errorCode: null, errorMessage: null })),
        error: [
          { id: null, tracking_number: 'DUP1', courier_code: 'dsv', errorCode: 4101, errorMessage: 'Tracking No. already exists.' },
          { id: null, tracking_number: 'BAD1', courier_code: 'dsv', errorCode: 4110, errorMessage: 'The value of tracking_number is invalid.' },
        ],
      }),
    });
    expect(await register(client)).toMatchObject({ submitted: 3, registered: 1, alreadyRegistered: 1, invalid: 1, failed: 0 });
    const rows = await db.select({ n: providerTrackings.trackingNumber, state: providerTrackings.state, warning: providerTrackings.lastWarning, error: providerTrackings.lastError }).from(providerTrackings);
    expect(rows.find((r) => r.n === 'DUP1')).toMatchObject({ state: 'awaiting_data', warning: expect.stringMatching(/no new credit/) });
    expect(rows.find((r) => r.n === 'BAD1')).toMatchObject({ state: 'invalid', error: expect.stringMatching(/4110/) });
    // Invalid numbers aren't resubmitted on the next click.
    expect((await planForScope(db, providers(client), { scope: 'open' })).preview.identitiesToRegister).toBe(0);
  });

  it('flags a reused number as a conflict instead of mixing two shipments', async () => {
    await seedShipments(db, [
      { carrier: 'DHL', trackingNumber: '1234567890', shipDate: '2026-01-05', actualArrivalDate: null },
      { carrier: 'DHL', trackingNumber: '1234567890', shipDate: '2026-10-01' },
    ]);
    let n = 0;
    const { client } = fakeClient({
      batchCreate: async (ps) => {
        n++;
        return {
          success: [{ id: 'old', tracking_number: ps[0].tracking_number, courier_code: 'dhl', errorCode: null, errorMessage: null }],
          error: [{ id: null, tracking_number: ps[1].tracking_number, courier_code: 'dhl', errorCode: 4101, errorMessage: 'exists' }],
        };
      },
    });
    // Two episodes of the same number+courier: the first is registered, the second hits "already exists".
    const { identities } = await planForScope(db, providers(client), { scope: 'open' });
    expect(identities.map((i) => i.episodeKey)).toEqual(['2026-01-05', '2026-10-01']);
    // Register the older one first so it counts as registered when the newer one comes back "exists".
    await registerIdentities(db, client, 'trackingmore', [identities[0]], 't');
    const second = await registerIdentities(db, fakeClient({ createTracking: async () => ({ outcome: 'exists' }) }).client, 'trackingmore', [identities[1]], 't');
    expect(second).toMatchObject({ conflicts: 1 });
    expect(n).toBe(0); // single identities go through create, not batch
    const states = await db.select({ e: providerTrackings.episodeKey, s: providerTrackings.state }).from(providerTrackings).orderBy(providerTrackings.episodeKey);
    expect(states).toEqual([
      { e: '2026-01-05', s: 'awaiting_data' },
      { e: '2026-10-01', s: 'conflict' },
    ]);
  });

  it('keeps failures retryable: quota exhausted, then registered later', async () => {
    await seedShipments(db, [{ carrier: 'DSV', trackingNumber: 'Q1', shipDate: '2026-10-10' }]);
    const quota = fakeClient({
      createTracking: async () => {
        throw new TrackingMoreQuotaError('quota', 4190, 400);
      },
    });
    expect(await register(quota.client)).toMatchObject({ submitted: 1, failed: 1, quotaExhausted: true });
    expect((await db.select({ s: providerTrackings.state }).from(providerTrackings))[0].s).toBe('register_failed');
    const ok = fakeClient();
    expect(await register(ok.client)).toMatchObject({ submitted: 1, registered: 1 });
    expect(await db.select().from(providerTrackings)).toHaveLength(1);
  });

  it('stops on a rejected API key and leaves the identities retryable', async () => {
    await seedShipments(db, [{ carrier: 'DSV', trackingNumber: 'A1', shipDate: '2026-10-10' }]);
    const bad = fakeClient({
      createTracking: async () => {
        throw new TrackingMoreAuthError('bad key', 401, 401);
      },
    });
    await expect(register(bad.client)).rejects.toBeInstanceOf(TrackingMoreAuthError);
    expect((await db.select({ s: providerTrackings.state }).from(providerTrackings))[0].s).toBe('register_failed');
  });

  it('limits recent arrivals to the chosen window', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const longAgo = '2025-01-01';
    await seedShipments(db, [
      { carrier: 'DSV', trackingNumber: 'R1', actualArrivalDate: today, arrivalSource: 'report_window', status: 'delivered' },
      { carrier: 'DSV', trackingNumber: 'R2', actualArrivalDate: longAgo, arrivalSource: 'report_window', status: 'delivered' },
      { carrier: 'DSV', trackingNumber: 'R3', actualArrivalDate: today, arrivalSource: 'manual', status: 'delivered' },
    ]);
    const { client } = fakeClient();
    const { preview } = await planForScope(db, providers(client), { scope: 'recent', recentDays: 30 });
    expect(preview).toMatchObject({ linesConsidered: 1, identitiesToRegister: 1 });
  });
});
