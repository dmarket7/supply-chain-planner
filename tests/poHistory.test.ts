import { Hono } from 'hono';
import { asc } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../server/db/client';
import { imports, inventorySnapshots, lineChanges, outboundSnapshots, poLineVersions, shipments } from '../server/db/schema';
import type { AppEnv } from '../server/env';
import { dedupeKeysForFile } from '../shared/importKeys';
import type { ImportResult, ShipmentInput } from '../shared/types';
import { createTestDb } from './helpers/testDb';

let db: Db;
vi.mock('../server/db/client', () => ({ getDb: () => db }));
const app = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    c.set('userId', 'tester');
    await next();
  })
  .route('/', (await import('../server/routes/imports')).importsRoutes);

const env = { DATABASE_URL: 'test' };
async function call<T>(path: string, body?: unknown) {
  const res = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }, env);
  return { status: res.status, body: (await res.json()) as T };
}

const line = (over: Partial<ShipmentInput>): ShipmentInput => ({
  supplier: 'ACME',
  poNumber: 'PO1',
  lineRef: '1',
  poStatus: 'open',
  partNumber: 'A',
  branch: 'JIT-MSUS-META',
  quantity: 100,
  promisedArrivalDate: '2026-10-20',
  ...over,
});

/** A Supplier POs import through the routes, rebuilding the history when the server asks for it. */
async function importReport(reportDate: string, lines: ShipmentInput[]) {
  const keys = dedupeKeysForFile(lines);
  const start = await call<{ importId: number; error?: string }>('/', { fileName: `po-${reportDate}.xlsx`, reportDate, rowCount: lines.length });
  if (start.status !== 201) return start;
  await call(`/${start.body.importId}/rows`, { rows: lines.map((l, i) => ({ ...l, dedupeKey: keys[i] })) });
  const done = await call<ImportResult>(`/${start.body.importId}/complete`);
  if (done.body.needsRebuild) await rebuild();
  return done;
}

async function rebuild() {
  const { body } = await call<{ batches: string[][] }>('/rebuild');
  for (const groups of body.batches) await call('/rebuild/batch', { groups });
  await call('/rebuild/finish');
}

/** The current lines and their change log, without ids, for comparing two import orders. */
async function state() {
  const lines = await db.select().from(shipments).orderBy(asc(shipments.dedupeKey));
  const reportDates = new Map((await db.select().from(imports)).map((i) => [i.id, i.reportDate]));
  const changes = await db.select().from(lineChanges);
  const keyById = new Map(lines.map((l) => [l.id, l.dedupeKey]));
  return {
    lines: lines.map((l) => ({
      key: l.dedupeKey,
      status: l.status,
      poStatus: l.poStatus,
      eta: l.promisedArrivalDate,
      arrived: l.actualArrivalDate,
      source: l.arrivalSource,
      lastSeenOpen: l.lastSeenOpenReportDate,
      first: reportDates.get(l.firstImportId!),
      last: reportDates.get(l.lastImportId!),
    })),
    changes: changes.map((c) => [keyById.get(c.shipmentId), c.reportDate, c.kind, c.fromValue, c.toValue].join(' ')).sort(),
  };
}

const oct10 = [line({}), line({ poNumber: 'PO2', promisedArrivalDate: null, partNumber: 'B' })];
const oct18 = [
  line({ promisedArrivalDate: '2026-10-27' }), // ETA moved
  line({ poNumber: 'PO2', asn: 'ASN-9', promisedArrivalDate: '2026-10-30', partNumber: 'B' }), // shipped under an ASN
  line({ poNumber: 'PO3', partNumber: 'C' }),
];
const oct25 = [line({ poStatus: 'closed', promisedArrivalDate: '2026-10-27' }), line({ poNumber: 'PO3', partNumber: 'C', poStatus: 'closed' })];

describe('Supplier PO history in any order', () => {
  beforeEach(async () => {
    ({ db } = await createTestDb());
  });

  it('builds the same lines and history whether reports come in date order or not', async () => {
    for (const [d, l] of [['2026-10-10', oct10], ['2026-10-18', oct18], ['2026-10-25', oct25]] as const) await importReport(d, l);
    const inOrder = await state();

    ({ db } = await createTestDb());
    expect((await importReport('2026-10-25', oct25)).status).toBe(200);
    const older = await importReport('2026-10-10', oct10);
    expect(older.body).toMatchObject({ needsRebuild: true });
    await importReport('2026-10-18', oct18);
    const outOfOrder = await state();

    expect(outOfOrder).toEqual(inOrder);
    expect(inOrder.changes).toEqual(expect.arrayContaining(['po:PO1:1: 2026-10-18 eta_changed 2026-10-20 2026-10-27', 'po:PO2:1:ASN-9 2026-10-18 shipped  ASN-9']));
    // PO1 was open on 10-18 and closed on 10-25, so it arrived in that window.
    expect(inOrder.lines.find((l) => l.key === 'po:PO1:1:')).toMatchObject({ source: 'report_window', arrived: '2026-10-25', lastSeenOpen: '2026-10-18' });
  });

  it('replaces a same-date re-upload, and deleting a report date rebuilds without it', async () => {
    await importReport('2026-10-10', oct10);
    await importReport('2026-10-18', [line({ promisedArrivalDate: '2026-11-30' })]);
    await importReport('2026-10-18', oct18);
    expect((await db.select().from(imports)).map((i) => i.reportDate)).toEqual(['2026-10-10', '2026-10-18']);
    const twoReports = await state();

    await importReport('2026-10-25', oct25);
    await db.insert(outboundSnapshots).values({ fileName: 'o', reportDate: '2026-10-25', uploadedBy: 't', completedAt: new Date() });
    await db.insert(inventorySnapshots).values({ fileName: 'i', reportDate: '2026-10-25', uploadedBy: 't', completedAt: new Date() });
    const { body } = await call<{ purchaseOrders: number; outbound: number; inventory: number; needsRebuild: boolean }>('/delete', { reportDate: '2026-10-25' });
    expect(body).toEqual({ purchaseOrders: 1, outbound: 1, inventory: 1, needsRebuild: true });
    await rebuild();

    expect(await state()).toEqual(twoReports);
    expect((await db.select().from(imports)).map((i) => i.reportDate)).toEqual(['2026-10-10', '2026-10-18']);
    expect(await db.select().from(outboundSnapshots)).toEqual([]);
  });

  it('keeps an arrival someone confirmed by hand through a rebuild', async () => {
    await importReport('2026-10-18', oct18);
    await db.update(shipments).set({ actualArrivalDate: '2026-10-19', arrivalSource: 'manual', status: 'delivered' });
    await importReport('2026-10-10', oct10);
    const po3 = (await db.select().from(shipments)).find((s) => s.poNumber === 'PO3')!;
    expect(po3).toMatchObject({ status: 'delivered', actualArrivalDate: '2026-10-19', arrivalSource: 'manual' });
  });

  it('keeps one copy of a line that did not change between reports', async () => {
    await importReport('2026-10-10', [line({})]);
    await importReport('2026-10-18', [line({})]);
    expect(await db.select().from(poLineVersions)).toHaveLength(1);
  });

  it('refuses an older report while reports imported before history was kept are still there', async () => {
    await db.insert(imports).values({ fileName: 'old.xlsx', reportDate: '2026-10-24', uploadedBy: 't', completedAt: new Date() });
    const res = await importReport('2026-10-10', oct10);
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toContain('2026-10-24');
    // A newer report still merges in.
    expect((await importReport('2026-10-30', oct10)).status).toBe(200);
  });
});
