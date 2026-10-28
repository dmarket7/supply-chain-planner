import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../server/db/client';
import { imports, lineChanges, outboundChanges, shipments, suppliers } from '../server/db/schema';
import type { AppEnv } from '../server/env';
import { diffOrders, etaMoveKey, matchesChangeFilter, summarizeChanges, type OrderRowForDiff } from '../shared/orderChanges';
import type { ImportHistoryRow, OrderHistoryResponse, OutboundOrderInput, OutboundResponse, OutboundSnapshotInfo } from '../shared/types';
import { createTestDb } from './helpers/testDb';

const row = (over: Partial<OrderRowForDiff>): OrderRowForDiff => ({
  soNumber: '1',
  cpn: 'A',
  shipTo: 'SITE',
  warehouse: 'JIT-MSUS-META',
  status: 'Reserved ordered',
  quantity: 100,
  confirmedShipDate: '2026-11-02',
  dockDate: '2026-11-09',
  scheduledShipDate: '2026-11-02',
  ...over,
});

describe('diffOrders', () => {
  it('sums reservation pieces per SO# + CPN, so a split order is not a change', () => {
    const prev = [row({ quantity: 100 })];
    const cur = [row({ quantity: 60 }), row({ quantity: 40 })];
    expect(diffOrders(prev, cur, new Set())).toEqual([]);
  });

  it('tags a ship date move with the dock date move as the customer', () => {
    const changes = diffOrders([row({})], [row({ confirmedShipDate: '2026-11-09', dockDate: '2026-11-16' })], new Set());
    expect(changes.find((c) => c.kind === 'confirmed_date')).toMatchObject({ from: '2026-11-02', to: '2026-11-09', causes: ['customer'] });
    expect(changes.find((c) => c.kind === 'dock_date')).toMatchObject({ from: '2026-11-09', to: '2026-11-16', causes: ['customer'] });
  });

  it('tags reservation shifts, inbound ETA moves at the same site, and quantity changes', () => {
    const moves = new Set([etaMoveKey('A', 'JIT-MSUS-QUARANTINE'), etaMoveKey('B', 'JIT-MMTN-META')]);
    const changes = diffOrders(
      [row({ status: 'On order' })],
      [row({ status: 'Reserved ordered', quantity: 80, confirmedShipDate: '2026-11-20' })],
      moves,
    );
    expect(changes.find((c) => c.kind === 'confirmed_date')?.causes).toEqual(['reservation', 'inbound_eta', 'quantity']);
    expect(changes.find((c) => c.kind === 'status')).toMatchObject({ from: 'On order 100', to: 'Reserved ordered 80' });
  });

  it('leaves causes empty when the report shows none, and lists new and gone lines', () => {
    const changes = diffOrders([row({}), row({ soNumber: '2' })], [row({ confirmedShipDate: '2026-10-30' }), row({ soNumber: '3' })], new Set());
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ soNumber: '1', kind: 'confirmed_date', causes: [] }),
        expect.objectContaining({ soNumber: '3', kind: 'new', to: '100' }),
        expect.objectContaining({ soNumber: '2', kind: 'gone', from: '100' }),
      ]),
    );
    expect(summarizeChanges(changes)).toMatchObject({ added: 1, gone: 1, pulledIn: 1, pushedOut: 0, noCause: 1 });
    expect(matchesChangeFilter(changes.filter((c) => c.soNumber === '1'), 'pulled')).toBe(true);
    expect(matchesChangeFilter(changes.filter((c) => c.soNumber === '1'), 'pushed')).toBe(false);
  });

  it('counts a first confirmed date apart from moves', () => {
    const changes = diffOrders([row({ confirmedShipDate: null })], [row({})], new Set());
    expect(summarizeChanges(changes)).toMatchObject({ newlyConfirmed: 1, pushedOut: 0, pulledIn: 0, noCause: 0 });
  });
});

let db: Db;
vi.mock('../server/db/client', () => ({ getDb: () => db }));
const withUser = <T extends Hono<AppEnv>>(routes: T, userId = 'tester') =>
  new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('userId', userId);
      c.set('userLabel', `${userId}@example.com`);
      await next();
    })
    .route('/', routes);
const { outboundRoutes } = await import('../server/routes/outbound');
const outbound = withUser(outboundRoutes);
const otherUser = withUser(outboundRoutes, 'someone-else');
const reports = withUser((await import('../server/routes/reports')).reportsRoutes);
const importsApi = withUser((await import('../server/routes/imports')).importsRoutes);

const env = { DATABASE_URL: 'test' };
const call = async <T,>(app: Hono<AppEnv>, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, body: (await res.json()) as T };
};

const order = (over: Partial<OutboundOrderInput>): OutboundOrderInput => ({
  soNumber: '1',
  emsPo: null,
  status: 'Reserved ordered',
  warehouse: 'JIT-MSUS-META',
  shipTo: 'SITE A',
  cpn: 'A',
  mpn: 'MPN-A',
  manufacturer: null,
  businessGroup: 'SSD',
  packagingType: null,
  quantity: 100,
  totalPrice: null,
  sourceRows: 1,
  shipDate: '2026-11-02',
  shipDateSource: 'confirmed',
  scheduledShipDate: '2026-11-02',
  confirmedShipDate: '2026-11-02',
  dockDate: '2026-11-09',
  originalRequestDate: '2026-11-09',
  poReceiptDate: null,
  ...over,
});

async function importSnapshot(reportDate: string, orders: OutboundOrderInput[]) {
  const { body } = await call<{ snapshotId: number }>(outbound, '/snapshots', 'POST', { fileName: `r-${reportDate}.xlsx`, reportDate, rowCount: orders.length, orderCount: orders.length, skippedQuotations: 0 });
  if (orders.length) await call(outbound, `/snapshots/${body.snapshotId}/orders`, 'POST', { orders });
  return (await call<OutboundSnapshotInfo>(outbound, `/snapshots/${body.snapshotId}/complete`, 'POST', {})).body;
}

/** A PO line for part A at JIT-MSUS whose ETA moved in the 10-18 report. */
async function etaMovedOn(reportDate: string) {
  const [supplier] = await db.insert(suppliers).values({ name: 'ACME' }).returning();
  const [imp] = await db.insert(imports).values({ fileName: 'po.xlsx', reportDate, uploadedBy: 't', completedAt: new Date() }).returning();
  const [line] = await db
    .insert(shipments)
    .values({ dedupeKey: 'po-1', supplierId: supplier.id, partNumber: 'A', branch: 'JIT-MSUS-META', status: 'in_transit', quantity: 100 })
    .returning();
  await db.insert(lineChanges).values({ shipmentId: line.id, importId: imp.id, reportDate, kind: 'eta_changed', fromValue: '2026-10-28', toValue: '2026-11-12' });
}

describe('order change routes', () => {
  beforeEach(async () => {
    ({ db } = await createTestDb());
  });

  it('stores changes with their causes and shows them on the outbound report and in the history', async () => {
    await etaMovedOn('2026-10-18');
    await importSnapshot('2026-10-10', [order({}), order({ soNumber: '2', cpn: 'B' })]);
    const info = await importSnapshot('2026-10-18', [order({ shipDate: '2026-11-16', confirmedShipDate: '2026-11-16' }), order({ soNumber: '3' })]);
    expect(info.changes?.summary).toMatchObject({ pushedOut: 1, added: 1, gone: 1, noCause: 0 });

    const { body: report } = await call<OutboundResponse>(reports, '/outbound?from=2026-10-01&to=2026-12-31');
    const line = report.shipTos.flatMap((s) => s.lines).find((o) => o.soNumber === '1')!;
    expect(line.originalRequestDate).toBe('2026-11-09');
    expect(line.changes).toEqual([{ kind: 'confirmed_date', from: '2026-11-02', to: '2026-11-16', causes: ['inbound_eta'] }]);

    const { body: history } = await call<OrderHistoryResponse>(outbound, '/history?so=1&cpn=A');
    expect(history.reports.map((r) => [r.reportDate, r.line?.confirmedShipDate])).toEqual([
      ['2026-10-10', '2026-11-02'],
      ['2026-10-18', '2026-11-16'],
    ]);
    expect(history.changes).toHaveLength(1);
  });

  it('recomputes the next report when an older one is imported late', async () => {
    await importSnapshot('2026-10-18', [order({ confirmedShipDate: '2026-11-16' })]);
    await importSnapshot('2026-10-01', [order({ confirmedShipDate: '2026-10-20' })]);
    await importSnapshot('2026-10-10', [order({})]);
    const rows = await db.select().from(outboundChanges);
    expect(rows.map((r) => [r.previousReportDate, r.reportDate, r.fromValue, r.toValue]).sort()).toEqual([
      ['2026-10-01', '2026-10-10', '2026-10-20', '2026-11-02'],
      ['2026-10-10', '2026-10-18', '2026-11-02', '2026-11-16'],
    ]);
  });

  it('keeps notes across a re-import, and only the author can delete one', async () => {
    await importSnapshot('2026-10-10', [order({})]);
    await importSnapshot('2026-10-18', [order({ confirmedShipDate: '2026-11-16' })]);
    const note = { soNumber: '1', cpn: 'A', reportDate: '2026-10-18', kind: 'confirmed_date', note: 'Supplier slipped a week' };
    const { status, body } = await call<{ id: number }>(outbound, '/notes', 'POST', note);
    expect(status).toBe(201);
    expect((await call(outbound, '/notes', 'POST', { ...note, note: '  ' })).status).toBe(400);

    await importSnapshot('2026-10-18', [order({ confirmedShipDate: '2026-11-16' })]);
    const { body: history } = await call<OrderHistoryResponse>(outbound, '/history?so=1&cpn=A');
    expect(history.notes).toEqual([expect.objectContaining({ note: 'Supplier slipped a week', author: 'tester@example.com', mine: true })]);
    expect(history.changes).toHaveLength(1);

    expect((await call(otherUser, `/notes/${body.id}`, 'DELETE')).status).toBe(404);
    expect((await call(outbound, `/notes/${body.id}`, 'DELETE')).status).toBe(200);
  });

  it('lists each report date with what changed per tab', async () => {
    await etaMovedOn('2026-10-18');
    await importSnapshot('2026-10-10', [order({})]);
    await importSnapshot('2026-10-18', [order({ confirmedShipDate: '2026-11-16' })]);
    const { body } = await call<ImportHistoryRow[]>(importsApi, '/history');
    expect(body.map((r) => r.reportDate)).toEqual(['2026-10-18', '2026-10-10']);
    expect(body[0].outbound?.summary).toMatchObject({ pushedOut: 1 });
    expect(body[0].inbound?.counts.eta_moved).toBe(1);
    expect(body[1].outbound?.summary).toBeNull();
    expect(body[0].inventory).toBeNull();
  });
});
