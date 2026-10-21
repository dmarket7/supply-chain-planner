import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../server/db/client';
import { carrierMappings, providerCouriers, providerTrackings, shipments } from '../server/db/schema';
import type { CoverageRow } from '../shared/types';
import { createTestDb, seedShipments } from './helpers/testDb';

let db: Db;
vi.mock('../server/db/client', () => ({ getDb: () => db }));
const { trackingSetupRoutes } = await import('../server/routes/trackingSetup');

const env = { DATABASE_URL: 'test', TRACKINGMORE_ENABLED: 'true', TRACKINGMORE_API_KEY: 'test-key' };
const coverage = async () => ((await (await trackingSetupRoutes.request('/coverage', {}, env)).json()) as { rows: CoverageRow[] }).rows;

describe('coverage for changing a carrier\'s courier', () => {
  beforeEach(async () => {
    ({ db } = await createTestDb());
    await db.insert(providerCouriers).values(
      [['fedex', 'FedEx'], ['fedex-unified-api', 'FedEx API'], ['fedex-freight', 'Fedex Freight']].map(([courierCode, name]) => ({ provider: 'trackingmore', courierCode, name })),
    );
    await db.insert(carrierMappings).values({ provider: 'trackingmore', carrier: 'FedEx', prefix: '', courierCode: 'fedex-unified-api', status: 'mapped', confirmedBy: 'test' });
  });

  it('counts registrations under the mapped courier, flags stalled ones and offers alternatives', async () => {
    const [a, b, c] = await seedShipments(db, [
      { carrier: 'FedEx', trackingNumber: '546238307340' },
      { carrier: 'FedEx', trackingNumber: '546238307340' }, // same parcel, second PO line
      { carrier: 'FedEx', trackingNumber: '111111111111', actualArrivalDate: '2026-10-01' },
    ]);
    const regs = await db
      .insert(providerTrackings)
      .values([
        { provider: 'trackingmore', courierCode: 'fedex-unified-api', trackingNumber: '546238307340', episodeKey: 'e1', state: 'awaiting_data', registeredAt: new Date(Date.now() - 8 * 3_600_000) },
        { provider: 'trackingmore', courierCode: 'fedex-unified-api', trackingNumber: '111111111111', episodeKey: 'e1', state: 'active', registeredAt: new Date(Date.now() - 8 * 3_600_000), latestCheckpointAt: new Date() },
      ])
      .returning({ id: providerTrackings.id });
    await db.update(shipments).set({ trackingRegistrationId: regs[0].id }).where(eq(shipments.id, a));
    await db.update(shipments).set({ trackingRegistrationId: regs[0].id }).where(eq(shipments.id, b));
    await db.update(shipments).set({ trackingRegistrationId: regs[1].id }).where(eq(shipments.id, c));

    const [row] = await coverage();
    expect(row).toMatchObject({
      carrier: 'FedEx',
      route: 'mapped',
      courierCode: 'fedex-unified-api',
      lines: 3,
      registeredLines: 3,
      registrations: 2,
      stalledRegistrations: 1,
      sampleNumber: '546238307340', // an open line's number
      suggested: 'fedex',
    });
    expect(row.candidates.map((x) => x.courierCode)).toEqual(['fedex', 'fedex-freight', 'fedex-unified-api']);
  });
});
