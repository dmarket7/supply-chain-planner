import { Hono } from 'hono';
import * as XLSX from 'xlsx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, todayIso } from '../shared/dates';
import { checkSupply, isHeldBranch, siteOf, type SupplyInbound, type SupplyOrder, type SupplyPosition } from '../shared/supply';
import type { Db } from '../server/db/client';
import { inventorySnapshots, palletRatios } from '../server/db/schema';
import type { AppEnv } from '../server/env';
import type { DashboardResponse, InventoryPositionInput, OutboundOrderInput, OutboundResponse, SupplyResponse } from '../shared/types';
import { findInventorySheet, parseInventorySummary } from '../src/features/import/parseInventorySummary';
import { createTestDb, seedShipments } from './helpers/testDb';

const HEADERS = ['InvStatus', 'Commodity', 'WintecPN', 'VendorPN', 'Description', 'Branch', 'MaterialRecDate', 'On Receipt', 'OnhandQTY', 'ReservedQTY', 'AllocatedQTY', 'AvailableQTY'];
const invRow = (over: Partial<Record<(typeof HEADERS)[number], string | number>> = {}) => {
  const r: Record<string, string | number> = {
    InvStatus: 'Open', Commodity: 'SSD', WintecPN: 'MET-000001', VendorPN: 'MZ-1', Description: 'PM9A2 256GB', Branch: 'JIT-MSUS-META',
    MaterialRecDate: 46000, 'On Receipt': 0, OnhandQTY: 100, ReservedQTY: 40, AllocatedQTY: 0, AvailableQTY: 60,
    ...over,
  };
  return HEADERS.map((h) => r[h]);
};

describe('reading the Inventory Summary tab', () => {
  it('sums open lots per part and branch, nets transfers, and skips closed lots', () => {
    const wb = XLSX.utils.book_new();
    // Same columns on another tab: the name decides.
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, invRow()]), 'Sourcing Manager Detail');
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        HEADERS,
        invRow(),
        invRow({ OnhandQTY: -300, ReservedQTY: 0, AvailableQTY: -300, MaterialRecDate: 45900 }), // transfer out…
        invRow({ OnhandQTY: 300, ReservedQTY: 0, AvailableQTY: 300 }), // …and back in the same branch
        invRow({ Branch: 'JIT-MSUS-QUARANTINE', OnhandQTY: 25, ReservedQTY: 0, AvailableQTY: 25 }),
        invRow({ InvStatus: 'Closed', OnhandQTY: 0, AvailableQTY: 0 }),
        invRow({ WintecPN: '', OnhandQTY: 1 }),
      ]),
      'Inventory Summary',
    );
    expect(findInventorySheet(wb)).toBe('Inventory Summary');
    const p = parseInventorySummary(wb, 'Inventory Summary');
    expect(p).toMatchObject({ rowCount: 6, closedRows: 1, parts: 1, heldUnits: 25 });
    expect(p.errors).toEqual(['Row 7: no WintecPN']);
    expect(p.positions).toEqual([
      expect.objectContaining({ branch: 'JIT-MSUS-META', onhand: 100, reserved: 40, available: 60, sourceRows: 3, oldestReceiptDate: '2025-12-09' }),
      expect.objectContaining({ branch: 'JIT-MSUS-QUARANTINE', onhand: 25, available: 25 }),
    ]);
  });

  it('names the missing columns', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['WintecPN', 'Branch', 'OnhandQTY'], ['A', 'B', 1]]), 'Inventory Summary');
    expect(findInventorySheet(wb)).toBeNull();
    expect(() => parseInventorySummary(wb, 'Inventory Summary')).toThrow(/availableqty/);
  });
});

describe('sites and held branches', () => {
  it('groups branches by warehouse and holds quarantine stock', () => {
    expect(siteOf('JIT-MSUS-QUARANTINE')).toBe('JIT-MSUS');
    expect(siteOf('DBS-TW-QUARANTINE-META')).toBe(siteOf('DBS-TW-META'));
    for (const b of ['JIT-MSUS-QUARANTINE', 'JIT-MSUS-Finance-Qua', 'JIT-MMTN-META-QRT', 'JIT-MSUS-RMA_CM', 'JIT-MSUS-CYCLECOUNT', 'JIT-IN TRANSIT']) {
      expect(isHeldBranch(b)).toBe(true);
    }
    expect(isHeldBranch('JIT-MSUS-META')).toBe(false);
  });
});

describe('supply check', () => {
  const pos = (over: Partial<SupplyPosition> = {}): SupplyPosition => ({ partNumber: 'P', branch: 'JIT-MSUS-META', onhand: 0, reserved: 0, available: 0, onReceipt: 0, ...over });
  let seq = 0;
  const so = (over: Partial<SupplyOrder>): SupplyOrder => ({ id: ++seq, cpn: 'P', warehouse: 'JIT-MSUS-META', status: 'On order', quantity: 10, shipDate: '2026-11-10', soNumber: String(seq), ...over });
  const po = (over: Partial<SupplyInbound>): SupplyInbound => ({ id: ++seq, partNumber: 'P', branch: 'JIT-MSUS-META', quantity: 10, eta: '2026-11-01', shipDate: null, ...over });

  it('marks reserved stock ready, uses free stock for on-order demand, and is short for the rest', () => {
    const ready = so({ status: 'Reserved Physical', quantity: 40 });
    const fromStock = so({ quantity: 50, shipDate: '2026-11-01' });
    const partly = so({ quantity: 30, shipDate: '2026-11-02' });
    const check = checkSupply(
      [pos({ onhand: 100, reserved: 40, available: 60 }), pos({ branch: 'JIT-MSUS-QUARANTINE', onhand: 500, available: 500 })],
      [ready, fromStock, partly],
      [],
    );
    expect(check.orders.get(ready.id)).toMatchObject({ readiness: 'ready' });
    expect(check.orders.get(fromStock.id)).toMatchObject({ readiness: 'stock', shortUnits: 0 });
    expect(check.orders.get(partly.id)).toMatchObject({ readiness: 'short', shortUnits: 20 }); // quarantine stock doesn't count
    expect(check.parts[0]).toMatchObject({ site: 'JIT-MSUS', available: 60, held: 500, shortUnits: 20, firstShortDate: '2026-11-02', readiness: 'short' });
    expect(check.parts[0].demand).toEqual({ physical: 40, ordered: 0, onOrder: 80 });
  });

  it('matches reserved-ordered demand to inbound by ETA, first in first out', () => {
    const first = so({ status: 'Reserved ordered', shipDate: '2026-11-05' });
    const second = so({ status: 'Reserved ordered', shipDate: '2026-11-06' });
    const check = checkSupply([pos({ onReceipt: 20 })], [second, first], [po({ eta: '2026-11-08' }), po({ eta: '2026-11-01' })]);
    expect(check.orders.get(first.id)).toMatchObject({ readiness: 'inbound', coveredBy: '2026-11-01' });
    expect(check.orders.get(second.id)).toMatchObject({ readiness: 'late', coveredBy: '2026-11-08' });
    expect(check.parts[0].nextInboundEta).toBe('2026-11-01');
  });

  it('says "no ETA" until the supplier gives one, but late once its ship date is past the order date', () => {
    const waiting = so({ status: 'Reserved ordered', shipDate: '2026-11-20' });
    const late = so({ status: 'Reserved ordered', shipDate: '2026-11-21', cpn: 'Q' });
    const check = checkSupply([], [waiting, late], [po({ eta: null, shipDate: '2026-11-15' }), po({ partNumber: 'Q', eta: null, shipDate: '2026-11-25' })]);
    expect(check.orders.get(waiting.id)).toMatchObject({ readiness: 'noEta', supplierShipDate: '2026-11-15' });
    expect(check.orders.get(late.id)).toMatchObject({ readiness: 'late', supplierShipDate: '2026-11-25' });
  });

  it('gives on-order demand the inbound left after reserved orders, and reports on-receipt supply with no PO line as no ETA', () => {
    const reserved = so({ status: 'Reserved ordered', quantity: 10 });
    const onOrder = so({ quantity: 15 });
    const check = checkSupply([pos({ onReceipt: 30 })], [reserved, onOrder], [po({ quantity: 20 })]);
    expect(check.orders.get(reserved.id)).toMatchObject({ readiness: 'inbound' });
    expect(check.orders.get(onOrder.id)).toMatchObject({ readiness: 'noEta', shortUnits: 0 }); // 10 timed + 5 of the 10 untimed
  });

  it('keeps sites apart', () => {
    const tw = so({ warehouse: 'DBS-TW-META' });
    const check = checkSupply([pos({ available: 100 })], [tw], []);
    expect(check.orders.get(tw.id)).toMatchObject({ readiness: 'short', shortUnits: 10 });
  });
});

let db: Db;
vi.mock('../server/db/client', () => ({ getDb: () => db }));
const withUser = <T extends Hono<AppEnv>>(routes: T) =>
  new Hono<AppEnv>().use('*', async (c, next) => { c.set('userId', 'tester'); await next(); }).route('/', routes);
const inventory = withUser((await import('../server/routes/inventory')).inventoryRoutes);
const outbound = withUser((await import('../server/routes/outbound')).outboundRoutes);
const reports = withUser((await import('../server/routes/reports')).reportsRoutes);

const env = { DATABASE_URL: 'test' };
const postTo = async <T,>(app: Hono<AppEnv>, path: string, body: unknown) =>
  (await (await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)).json()) as T;
const get = async <T,>(path: string) => (await (await reports.request(path, {}, env)).json()) as T;

const today = todayIso();
const position = (over: Partial<InventoryPositionInput>): InventoryPositionInput => ({
  partNumber: 'A',
  branch: 'JIT-MSUS-META',
  vendorPn: 'MPN-A',
  description: 'SSD A',
  commodity: 'SSD',
  onhand: 0,
  reserved: 0,
  allocated: 0,
  available: 0,
  onReceipt: 0,
  oldestReceiptDate: null,
  sourceRows: 1,
  ...over,
});
const order = (over: Partial<OutboundOrderInput>): OutboundOrderInput => ({
  soNumber: '1',
  originalRequestDate: null,
  emsPo: null,
  status: 'On order',
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
  shipDate: addDays(today, 3),
  shipDateSource: 'confirmed',
  scheduledShipDate: null,
  confirmedShipDate: null,
  dockDate: null,
  poReceiptDate: null,
  ...over,
});

async function importInventory(reportDate: string, positions: InventoryPositionInput[]) {
  const { snapshotId } = await postTo<{ snapshotId: number }>(inventory, '/snapshots', { fileName: 'r.xlsx', reportDate, rowCount: positions.length, positionCount: positions.length });
  if (positions.length) await postTo(inventory, `/snapshots/${snapshotId}/positions`, { positions });
  return postTo<{ reportDate: string }>(inventory, `/snapshots/${snapshotId}/complete`, {});
}
async function importOrders(reportDate: string, orders: OutboundOrderInput[]) {
  const { snapshotId } = await postTo<{ snapshotId: number }>(outbound, '/snapshots', { fileName: 'r.xlsx', reportDate, rowCount: orders.length, orderCount: orders.length, skippedQuotations: 0 });
  await postTo(outbound, `/snapshots/${snapshotId}/orders`, { orders });
  return postTo(outbound, `/snapshots/${snapshotId}/complete`, {});
}

describe('inventory import, supply and dashboard reports', () => {
  beforeEach(async () => {
    ({ db } = await createTestDb());
    await db.insert(palletRatios).values({ partNumber: 'A', unitsPerPallet: 100, palletsPerTruck: 26, productGroup: 'SSD', source: 'file', updatedBy: 't' });
  });

  it('replaces re-uploads of the same report date', async () => {
    await importInventory('2026-10-10', [position({ available: 1 })]);
    await importInventory('2026-10-18', [position({ available: 2 })]);
    await importInventory('2026-10-18', [position({ available: 3 })]);
    expect((await db.select().from(inventorySnapshots)).map((s) => s.reportDate)).toEqual(['2026-10-10', '2026-10-18']);
    const body = await get<SupplyResponse>('/supply');
    expect(body.inventory).toMatchObject({ reportDate: '2026-10-18' });
    expect(body.parts[0]).toMatchObject({ partNumber: 'A', available: 3, readiness: null });
  });

  it('leaves readiness out until an inventory is imported', async () => {
    await importOrders('2026-10-18', [order({})]);
    const body = await get<OutboundResponse>('/outbound');
    expect(body.inventoryReportDate).toBeNull();
    expect(body.shipTos[0].lines[0].supply).toBeNull();
    expect((await get<SupplyResponse>('/supply')).parts).toEqual([]);
  });

  it('checks orders against stock and inbound, per branch', async () => {
    await importInventory('2026-10-18', [
      position({ available: 150, onhand: 150, onReceipt: 300 }),
      position({ branch: 'DBS-TW-META', available: 1000, onhand: 1000 }),
    ]);
    const [ok, late] = await seedShipments(db, [
      { partNumber: 'A', branch: 'JIT-MSUS-META', quantity: 100, promisedArrivalDate: addDays(today, 1), poNumber: 'PO1' },
      { partNumber: 'A', branch: 'JIT-MSUS-META', quantity: 200, promisedArrivalDate: addDays(today, 20), poNumber: 'PO2' },
      { partNumber: 'A', branch: 'JIT-MSUS-META', quantity: 50, promisedArrivalDate: addDays(today, -2), poNumber: 'PO3', poStatus: 'closed' },
    ]);
    await importOrders('2026-10-18', [
      order({ soNumber: '1', quantity: 150 }), // stock
      order({ soNumber: '2', quantity: 100, shipDate: addDays(today, 4) }), // PO1, on time
      order({ soNumber: '3', quantity: 250, shipDate: addDays(today, 5) }), // PO2 is late; 50 short
      order({ soNumber: '4', quantity: 10, status: 'Reserved Physical', shipDate: '2026-10-01' }), // overdue but ready
      order({ soNumber: '5', quantity: 10, warehouse: 'DBS-TW-META' }),
    ]);

    const out = await get<OutboundResponse>(`/outbound?from=${today}&to=${addDays(today, 7)}&branch=JIT-MSUS-META`);
    const bySo = Object.fromEntries(out.shipTos[0].lines.map((l) => [l.soNumber, l.supply]));
    expect(bySo['1']).toMatchObject({ readiness: 'stock' });
    expect(bySo['2']).toMatchObject({ readiness: 'inbound', coveredBy: addDays(today, 1) });
    expect(bySo['3']).toMatchObject({ readiness: 'short', shortUnits: 50, coveredBy: addDays(today, 20) });
    expect(out.shipTos[0].readiness).toMatchObject({ stock: { orders: 1, units: 150, palletEq: 1.5 }, short: { orders: 1 } });

    const supply = await get<SupplyResponse>('/supply?branch=JIT-MSUS-META');
    expect(supply.parts).toHaveLength(1);
    expect(supply.parts[0]).toMatchObject({ partNumber: 'A', site: 'JIT-MSUS', shortUnits: 50, mpn: 'MPN-A' });
    expect(supply.parts[0].inbound.map((i) => i.id)).toEqual([ok, late]);
    expect(supply.parts[0].orderRows.map((o) => o.soNumber)).toEqual(['4', '1', '2', '3']);

    const dash = await get<DashboardResponse>('/dashboard?branch=JIT-MSUS-META');
    expect(dash.asOf).toEqual({ purchaseOrders: null, outbound: '2026-10-18', inventory: '2026-10-18' });
    expect(dash.buckets.map((b) => b.key)).toEqual(['before', 'week-0', 'week-1', 'week-2', 'week-3']);
    expect(dash.buckets[1].outbound).toMatchObject({ orders: 3, pallets: { palletEq: 5 } });
    expect(dash.buckets[1].inbound).toMatchObject({ lines: 1, topSuppliers: [expect.objectContaining({ palletEq: 1 })] });
    expect(dash.buckets[3].inbound.lines).toBe(1);
    expect(dash.exceptions.atRisk).toMatchObject({ count: 1, units: 250, rows: [expect.objectContaining({ soNumber: '3', readiness: 'short' })] });
    expect(dash.exceptions.overdue).toMatchObject({ count: 1, byReadiness: { ready: 1 } });
    expect(dash.exceptions.lateInbound.count).toBe(0); // the past-due line is closed
    expect(dash.exceptions.shortParts).toMatchObject({ count: 1, units: 50, rows: [expect.objectContaining({ partNumber: 'A' })] });
  });
});
