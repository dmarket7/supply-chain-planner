import { Hono } from 'hono';
import * as XLSX from 'xlsx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, todayIso } from '../shared/dates';
import type { Db } from '../server/db/client';
import { outboundSnapshots, palletRatios } from '../server/db/schema';
import type { AppEnv } from '../server/env';
import { addTruckGroup, emptyTrucks, RatioLookup, toPallets, type ResolvedRatio } from '../shared/pallets';
import type { OutboundOrderInput, OutboundResponse, OutboundSnapshotInfo, PalletRatiosResponse } from '../shared/types';
import { findOdmSheet, parseOdmOrders } from '../src/features/import/parseOdmOrders';
import { createTestDb } from './helpers/testDb';

const HEADERS = [
  'PO Receipt Date', 'Warehouse', 'System Schedule Ship Date', 'Wintec Confirmed Ship Date', 'EMS Requested Dock Date', 'STATUSISSUE',
  'Sales Type', 'Ship To', 'Wintec SO#', 'EMS PO#', 'Business Group', 'CPN', 'MPN', 'Quantity', 'Total Price',
];
// Excel serials: 46311 = 2026-10-16, 46325 = 2026-10-30, 72937 = 2099 placeholder.
const odmRow = (over: Partial<Record<(typeof HEADERS)[number], string | number>> = {}) => {
  const r: Record<string, string | number> = {
    'PO Receipt Date': 46290, Warehouse: 'JIT-MSUS-META', 'System Schedule Ship Date': 46311, 'Wintec Confirmed Ship Date': 46311,
    'EMS Requested Dock Date': 46325, STATUSISSUE: 'Reserved Physical', 'Sales Type': 'Sales order', 'Ship To': 'CELESTICA   THAILAND LIMITED',
    'Wintec SO#': '1013341', 'EMS PO#': 'CMX1', 'Business Group': 'SSD', CPN: 'MET-000240', MPN: 'HFS960', Quantity: 61, 'Total Price': 610,
    ...over,
  };
  return HEADERS.map((h) => r[h]);
};
const workbook = (rows: (string | number)[][]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Report']]), 'Supplier POs');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, ...rows]), 'ODM Open Order');
  return wb;
};

describe('reading the ODM Open Order tab', () => {
  it('sums reservation pieces (identical rows included) and skips quotations', () => {
    const wb = workbook([
      odmRow(),
      odmRow(), // an identical piece is still real quantity
      odmRow({ Quantity: 139, 'Total Price': 1390 }),
      odmRow({ STATUSISSUE: 'On order', Quantity: 10 }),
      odmRow({ 'Sales Type': 'Quotation', 'Wintec SO#': '999' }),
    ]);
    expect(findOdmSheet(wb)).toBe('ODM Open Order');
    const p = parseOdmOrders(wb, 'ODM Open Order');
    expect(p).toMatchObject({ rowCount: 5, skippedQuotations: 1, unscheduledOrders: 0, errors: [] });
    expect(p.orders).toHaveLength(2);
    expect(p.orders[0]).toMatchObject({
      soNumber: '1013341',
      status: 'Reserved Physical',
      shipTo: 'CELESTICA THAILAND LIMITED',
      quantity: 261,
      totalPrice: 2610,
      sourceRows: 3,
      shipDate: '2026-10-16',
      shipDateSource: 'confirmed',
      dockDate: '2026-10-30',
    });
    expect(p.orders[1]).toMatchObject({ status: 'On order', quantity: 10 });
  });

  it('falls back to the schedule date, and treats 2099 placeholders as unscheduled', () => {
    const p = parseOdmOrders(
      workbook([
        odmRow({ 'Wintec SO#': '1', 'Wintec Confirmed Ship Date': '' }),
        odmRow({ 'Wintec SO#': '2', 'Wintec Confirmed Ship Date': 72937 }),
        odmRow({ 'Wintec SO#': '3', 'Wintec Confirmed Ship Date': 72937, 'System Schedule Ship Date': 72937 }),
        odmRow({ 'Wintec SO#': '4', Quantity: 'n/a' }),
      ]),
      'ODM Open Order',
    );
    expect(p.orders.map((o) => [o.soNumber, o.shipDate, o.shipDateSource])).toEqual([
      ['1', '2026-10-16', 'scheduled'],
      ['2', '2026-10-16', 'scheduled'],
      ['3', null, null],
    ]);
    expect(p.unscheduledOrders).toBe(1);
    expect(p.errors).toEqual(['Row 5: quantity is not a number']);
  });

  it('names missing columns', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Wintec SO#', 'Ship To', 'CPN', 'Qty', 'x'], ['1', 'A', 'B', 1, 2]]), 'ODM Open Order');
    expect(findOdmSheet(wb)).toBeNull();
    expect(() => parseOdmOrders(wb, 'ODM Open Order')).toThrow(/missing column: quantity/);
  });
});

describe('trucks', () => {
  const ratio = (over: Partial<ResolvedRatio> = {}): ResolvedRatio => ({ basis: 'real', unitsPerPallet: 100, palletsPerTruck: 26, palletsPerTruckBasis: 'real', ...over });
  const line = (quantity: number, over: Partial<ResolvedRatio> = {}) => ({ quantity, pallets: toPallets(ratio(over), quantity) });

  it('shares trucks within a ship-to-day group and rounds up once per group', () => {
    const sum = emptyTrucks();
    addTruckGroup(sum, [line(1300), line(1300)]); // 13 + 13 pallets = exactly 1 truck
    addTruckGroup(sum, [line(100)]); // another site or day: its own truck
    expect(sum).toMatchObject({ trucksNeeded: 2, estimatedTruckloads: 0, noRatioLines: 0 });
    expect(sum.truckloads).toBeCloseTo(1 + 1 / 26, 6);
  });

  it('marks truckloads estimated when the pallet ratio or pallets per truck is not real, and leaves out no-ratio lines', () => {
    const sum = addTruckGroup(emptyTrucks(), [
      line(2600, { palletsPerTruckBasis: 'default' }),
      line(1300, { basis: 'estimated' }),
      line(50, { basis: 'none', unitsPerPallet: null }),
    ]);
    expect(sum).toMatchObject({ truckloads: 1.5, estimatedTruckloads: 1.5, trucksNeeded: 2, noRatioLines: 1, noRatioUnits: 50 });
  });

  it('falls back from the part to the commodity median to 26 pallets per truck', () => {
    const lookup = new RatioLookup([
      { partNumber: 'A', unitsPerPallet: 100, palletsPerTruck: 13, productGroup: 'SSD', source: 'file' },
      { partNumber: 'B', unitsPerPallet: 100, palletsPerTruck: null, productGroup: 'NIC', source: 'file' },
    ]);
    expect(lookup.resolve('X', 'SSD')).toMatchObject({ palletsPerTruck: 13, palletsPerTruckBasis: 'estimated' });
    expect(lookup.resolve('B', 'NIC')).toMatchObject({ palletsPerTruck: 26, palletsPerTruckBasis: 'default' });
  });
});

let db: Db;
vi.mock('../server/db/client', () => ({ getDb: () => db }));
const withUser = <T extends Hono<AppEnv>>(routes: T) =>
  new Hono<AppEnv>().use('*', async (c, next) => { c.set('userId', 'tester'); await next(); }).route('/', routes);
const outbound = withUser((await import('../server/routes/outbound')).outboundRoutes);
const reports = withUser((await import('../server/routes/reports')).reportsRoutes);
const ratios = withUser((await import('../server/routes/palletRatios')).palletRatiosRoutes);

const env = { DATABASE_URL: 'test' };
const post = async <T,>(path: string, body: unknown) =>
  (await (await outbound.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)).json()) as T;

const today = todayIso();
const order = (over: Partial<OutboundOrderInput>): OutboundOrderInput => ({
  soNumber: '1',
  emsPo: null,
  status: 'Reserved Physical',
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
  shipDate: today,
  shipDateSource: 'confirmed',
  scheduledShipDate: today,
  confirmedShipDate: today,
  dockDate: null,
  poReceiptDate: null,
  ...over,
});

async function importSnapshot(reportDate: string, orders: OutboundOrderInput[]) {
  const { snapshotId } = await post<{ snapshotId: number }>('/snapshots', { fileName: `r-${reportDate}.xlsx`, reportDate, rowCount: orders.length, orderCount: orders.length, skippedQuotations: 0 });
  if (orders.length) await post(`/snapshots/${snapshotId}/orders`, { orders });
  return post<OutboundSnapshotInfo>(`/snapshots/${snapshotId}/complete`, {});
}

describe('outbound import and report', () => {
  beforeEach(async () => {
    ({ db } = await createTestDb());
    await db.insert(palletRatios).values([
      { partNumber: 'A', unitsPerPallet: 100, palletsPerTruck: 26, itemName: 'SSD A', productGroup: 'SSD', source: 'file', updatedBy: 't' },
    ]);
  });

  it('reports what changed since the previous snapshot and replaces re-uploads of the same date', async () => {
    await importSnapshot('2026-10-10', [order({ soNumber: '1' }), order({ soNumber: '2' }), order({ soNumber: '3' })]);
    const second = await importSnapshot('2026-10-18', [order({ soNumber: '2', quantity: 50 }), order({ soNumber: '3' }), order({ soNumber: '4' })]);
    expect(second.changes).toEqual({ previousReportDate: '2026-10-10', noLongerListed: 1, added: 1, quantityChanged: 1 });

    const again = await importSnapshot('2026-10-18', [order({ soNumber: '3' })]);
    expect(again.changes).toMatchObject({ noLongerListed: 2, added: 0 });
    expect((await db.select().from(outboundSnapshots)).map((s) => s.reportDate)).toEqual(['2026-10-10', '2026-10-18']);
  });

  it('groups the current snapshot by day and ship-to, sharing trucks per ship-to and day', async () => {
    await importSnapshot('2026-10-18', [
      order({ soNumber: '1', quantity: 1300 }), // 13 pallets
      order({ soNumber: '2', quantity: 1300 }), // same site and day: shares the truck
      order({ soNumber: '3', quantity: 100, shipTo: 'SITE B' }),
      order({ soNumber: '4', quantity: 40, cpn: 'H', mpn: 'MPN-H', businessGroup: 'HDD', shipTo: 'SITE B' }), // no ratio
      order({ soNumber: '5', quantity: 200, shipDate: addDays(today, -3) }), // overdue
      order({ soNumber: '6', quantity: 200, shipDate: null, shipDateSource: null }), // unscheduled
      order({ soNumber: '7', quantity: 999, warehouse: 'DBS-TW-META' }),
    ]);
    const res = await reports.request(`/outbound?from=${today}&to=${addDays(today, 7)}&branch=JIT-MSUS-META`, {}, env);
    const body = (await res.json()) as OutboundResponse;

    expect(body.snapshot).toMatchObject({ reportDate: '2026-10-18', changes: null });
    expect(body.days).toHaveLength(1);
    expect(body.days[0]).toMatchObject({ date: today, orders: 4, trucks: { trucksNeeded: 2, noRatioLines: 1, noRatioUnits: 40 } });
    expect(body.days[0].pallets.palletEq).toBe(27);
    expect(body.shipTos.map((s) => [s.shipTo, s.orders, s.trucks.trucksNeeded])).toEqual([['SITE A', 2, 1], ['SITE B', 2, 1]]);
    expect(body.shipTos[0].parts[0]).toMatchObject({ mpn: 'MPN-A', itemName: 'SSD A', orders: 2, unitsByStatus: { 'Reserved Physical': 2600 } });
    expect(body.shipTos[1].parts.map((p) => p.basis)).toEqual(['real', 'none']);
    expect(body.overdue).toMatchObject({ orders: 1, pallets: { palletEq: 2 } });
    expect(body.unscheduled).toMatchObject({ orders: 1, pallets: { palletEq: 2 } });
  });

  it('returns an empty report before the first outbound import', async () => {
    const body = (await (await reports.request('/outbound', {}, env)).json()) as OutboundResponse;
    expect(body).toMatchObject({ snapshot: null, days: [], shipTos: [], overdue: { orders: 0 } });
  });

  it('lists outbound-only parts on the pallet ratios page', async () => {
    await importSnapshot('2026-10-18', [order({ cpn: 'Z', businessGroup: 'SSD', quantity: 30 }), order({ soNumber: '2', cpn: 'Z', quantity: 20 })]);
    const { rows } = (await (await ratios.request('/', {}, env)).json()) as PalletRatiosResponse;
    expect(rows.find((r) => r.partNumber === 'Z')).toMatchObject({ basis: 'estimated', source: null, outboundOrders: 2, outboundUnits: 50, openLines: 0 });
  });
});
