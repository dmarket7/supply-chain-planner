import { describe, expect, it } from 'vitest';
import {
  ageBucket,
  lastMonths,
  matchShipments,
  pastDueTrend,
  receiptToShip,
  receivedDates,
  scoreSuppliers,
  supplierLine,
  type SupplierLineInput,
} from '../shared/performance';
import { findTransactionsSheet, parseTransactions } from '../src/features/import/parseTransactions';
import * as XLSX from 'xlsx';

const line = (over: Partial<SupplierLineInput>): SupplierLineInput => ({
  id: 1,
  supplier: 'ACME',
  poNumber: '0150001',
  lineRef: '1-1',
  asn: null,
  trackingNumber: null,
  poStatus: 'open',
  status: 'pending',
  branch: 'JIT-MSUS-META',
  partNumber: 'A',
  quantity: 100,
  requestDate: null,
  etd: null,
  eta: '2026-10-20',
  actualArrivalDate: null,
  arrivalSource: null,
  firstReportDate: '2026-10-10',
  etaMoves: [],
  etdMoves: [],
  ...over,
});

describe('supplier lines', () => {
  it('measures arrival against the first ETA we recorded, not the one the supplier moved it to', () => {
    const l = supplierLine(
      line({ poStatus: 'closed', status: 'delivered', eta: '2026-10-27', etaMoves: [{ reportDate: '2026-10-18', from: '2026-10-20', to: '2026-10-27' }] }),
      '2026-10-27',
    );
    expect(l).toMatchObject({ firstEta: '2026-10-20', firstEtaSeen: '2026-10-10', arrivalBaseline: 'first', arrivalDaysLate: 7, etaMoves: 1, etaDaysPushed: 7 });
  });

  it('counts the promise date itself as on time (no grace beyond it)', () => {
    expect(supplierLine(line({ poStatus: 'closed' }), '2026-10-20').arrivalDaysLate).toBe(0);
    expect(supplierLine(line({ poStatus: 'closed' }), '2026-10-21').arrivalDaysLate).toBe(1);
  });

  it('only uses the first promise when it was recorded before the line arrived', () => {
    const before = supplierLine(line({ poStatus: 'closed', firstReportDate: '2026-10-18' }), '2026-10-15');
    expect(before).toMatchObject({ arrivalBaseline: 'final', arrivalDaysLate: -5 });
  });

  it('takes the first ETA set when a line was first listed without one', () => {
    const l = supplierLine(line({ eta: '2026-11-03', etaMoves: [{ reportDate: '2026-10-18', from: null, to: '2026-11-01' }, { reportDate: '2026-10-25', from: '2026-11-01', to: '2026-11-03' }] }), null);
    expect(l).toMatchObject({ firstEta: '2026-11-01', firstEtaSeen: '2026-10-18', etaMoves: 1 });
  });

  it('measures shipping against the first ETD once the line has shipped, and flags an ETD after the request', () => {
    const l = supplierLine(
      line({ asn: 'ASN1', etd: '2026-10-16', requestDate: '2026-10-12', etdMoves: [{ reportDate: '2026-10-18', from: '2026-10-14', to: '2026-10-16' }] }),
      null,
    );
    expect(l).toMatchObject({ shipped: '2026-10-16', shipBaseline: 'first', shipDaysLate: 2, etdAfterRequest: true });
    // Never measured against the final ETD: that is the ship date itself.
    expect(supplierLine(line({ asn: 'ASN1', etd: '2026-10-16', firstReportDate: '2026-10-18' }), null).shipBaseline).toBeNull();
  });
});

describe('received dates', () => {
  it("hands a PO line's lots to its deliveries in ETD order and falls back to the reports, never the ETA", () => {
    const lines = [
      line({ id: 1, lineRef: '1-1', etd: '2026-10-01', poStatus: 'closed' }),
      line({ id: 2, lineRef: '1-2', etd: '2026-10-08', poStatus: 'closed' }),
      line({ id: 3, lineRef: '2-1', poStatus: 'closed', actualArrivalDate: '2026-10-12', arrivalSource: 'report_window' }),
      line({ id: 4, lineRef: '3-1', poStatus: 'closed', actualArrivalDate: '2026-10-12', arrivalSource: 'eta' }),
      line({ id: 5, lineRef: '1-3', etd: '2026-10-09' }), // still open: not received
    ];
    const lots = [
      { poNumber: '150001', poLine: '1', receiptDate: '2026-10-11' },
      { poNumber: '0150001', poLine: '1', receiptDate: '2026-10-04' },
    ];
    expect(Object.fromEntries(receivedDates(lines, lots))).toEqual({ 1: '2026-10-04', 2: '2026-10-11', 3: '2026-10-12' });
  });
});

describe('supplier scorecard', () => {
  const today = '2026-10-29';
  const arrivals = (supplier: string, month: string, late: number, onTime: number) =>
    Array.from({ length: late + onTime }, (_, i) =>
      supplierLine(line({ id: Math.random(), supplier, poStatus: 'closed', eta: `${month}-10`, firstReportDate: `${month}-01` }), i < late ? `${month}-15` : `${month}-09`),
    );

  it('flags a supplier late at least half the time in each of the last three months', () => {
    const lines = [...arrivals('LATE', '2026-08', 4, 2), ...arrivals('LATE', '2026-09', 3, 2), ...arrivals('LATE', '2026-10', 5, 0), ...arrivals('GOOD', '2026-10', 0, 12)];
    const scores = scoreSuppliers(lines, { from: '2026-05-03', to: today, today, includeHistory: false });
    expect(scores.map((s) => [s.supplier, s.status])).toEqual([['LATE', 'consistently_late'], ['GOOD', 'reliable']]);
    expect(scores[0].arrival).toMatchObject({ count: 16, onTime: 4, onTimePct: 25, medianDaysLate: 5 });
  });

  it('flags a supplier getting worse when the last 30 days are 20 points worse than before', () => {
    const lines = [...arrivals('SLIP', '2026-07', 0, 6), ...arrivals('SLIP', '2026-10', 4, 2)];
    expect(scoreSuppliers(lines, { from: '2026-05-03', to: today, today, includeHistory: false })[0].status).toBe('getting_worse');
  });

  it('leaves lines received before their promise was recorded out unless history is on', () => {
    const early = [supplierLine(line({ poStatus: 'closed', firstReportDate: '2026-10-18' }), '2026-10-15')];
    expect(scoreSuppliers(early, { from: '2026-10-01', to: today, today, includeHistory: false })[0].arrival.count).toBe(0);
    expect(scoreSuppliers(early, { from: '2026-10-01', to: today, today, includeHistory: true })[0].arrival.count).toBe(1);
  });
});

describe('our shipping', () => {
  it('compares a shipment with the first confirmed and requested dates seen before it shipped', () => {
    const seen = [
      { emsPo: 'PO1', cpn: 'A', reportDate: '2026-10-03', confirmedShipDate: '2026-10-08', dockDate: '2026-10-10' },
      { emsPo: 'PO1', cpn: 'A', reportDate: '2026-10-10', confirmedShipDate: '2026-10-14', dockDate: '2026-10-10' },
      { emsPo: 'PO1', cpn: 'A', reportDate: '2026-10-18', confirmedShipDate: '2026-10-20', dockDate: '2026-10-10' }, // after it shipped
    ];
    const [s] = matchShipments([{ id: 1, shipTo: 'X', odmPo: 'PO1', partNumber: 'A', branch: 'B', quantity: 5, shipDate: '2026-10-15', soEtd: '2026-10-14' }], seen);
    expect(s).toMatchObject({ firstConfirmed: '2026-10-08', lastConfirmed: '2026-10-14', confirmedMoves: 1, vsConfirmed: 7, vsRequest: 5, vsEtd: 1 });
    const [none] = matchShipments([{ id: 2, shipTo: 'X', odmPo: 'PO9', partNumber: 'A', branch: 'B', quantity: 5, shipDate: '2026-10-15', soEtd: null }], seen);
    expect(none).toMatchObject({ vsConfirmed: null, vsRequest: null, vsEtd: null });
  });

  it('reads shipped lines from the Transactions tab and numbers repeats', () => {
    const headers = ['SOShipDate', 'SOETDDate', 'WintecPN', 'Branch', 'ODM', 'ODM_PO', 'ODM_POLine', 'WintecPO', 'SOStatus', 'SOOrderQty', 'Inventory Receipt Date'];
    const row = [46311, 46309, 'MET-1', 'JIT-MSUS-META', 'CELESTICA', '6020', 10, '0153096', 'Shipped', 100, 46200];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, row, row]), 'Transactions');
    const parsed = parseTransactions(wb, findTransactionsSheet(wb)!);
    expect(parsed.rows.map((r) => r.dedupeKey)).toEqual(['so:6020:10:MET-1:2026-10-16:0153096', 'so:6020:10:MET-1:2026-10-16:0153096#2']);
    expect(parsed.rows[0]).toMatchObject({ soEtd: '2026-10-14', receiptDate: '2026-06-27', quantity: 100 });
  });
});

describe('receiving', () => {
  it('ages past-due lines per report and branch', () => {
    const rows = [
      { reportDate: '2026-10-10', branch: 'A', daysPastDue: 3, quantity: 10 },
      { reportDate: '2026-10-10', branch: 'B', daysPastDue: 40, quantity: 5 },
      { reportDate: '2026-10-18', branch: 'A', daysPastDue: 11, quantity: 10 },
    ];
    expect(pastDueTrend(rows)).toEqual([
      { reportDate: '2026-10-10', lines: 2, units: 15, d1_7: 1, d8_14: 0, d15_30: 0, d30: 1 },
      { reportDate: '2026-10-18', lines: 1, units: 10, d1_7: 0, d8_14: 1, d15_30: 0, d30: 0 },
    ]);
    expect(pastDueTrend(rows, 'B')).toHaveLength(1);
    expect([7, 8, 30, 31].map(ageBucket)).toEqual(['d1_7', 'd8_14', 'd15_30', 'd30']);
  });

  it('gives the median days from receipt to shipping per branch and month', () => {
    const months = lastMonths('2026-10-29', 2);
    expect(months).toEqual(['2026-09', '2026-10']);
    const r = receiptToShip(
      [
        { branch: 'A', receiptDate: '2026-09-01', shipDate: '2026-09-11' },
        { branch: 'A', receiptDate: '2026-09-01', shipDate: '2026-10-01' },
        { branch: 'A', receiptDate: null, shipDate: '2026-10-01' },
      ],
      months,
    );
    expect(r).toEqual([{ branch: 'A', shipments: 2, medianDays: 20, months: [{ month: '2026-09', count: 1, medianDays: 10 }, { month: '2026-10', count: 1, medianDays: 30 }] }]);
  });
});

/* ---------- Routes on PGlite ---------- */

import { Hono } from 'hono';
import { vi } from 'vitest';
import type { Db } from '../server/db/client';
import type { AppEnv } from '../server/env';
import { dedupeKeysForFile } from '../shared/importKeys';
import type { OutboundOrderInput, ReceivingResponse, ShipmentInput, ShippingPerformanceResponse, SupplierDetailResponse, SupplierPerformanceResponse } from '../shared/types';
import { createTestDb } from './helpers/testDb';

let db: Db;
vi.mock('../server/db/client', () => ({ getDb: () => db }));
const app = new Hono<AppEnv>().use('*', async (c, next) => {
  c.set('userId', 't');
  c.set('userLabel', 't');
  await next();
});
app.route('/imports', (await import('../server/routes/imports')).importsRoutes);
app.route('/outbound', (await import('../server/routes/outbound')).outboundRoutes);
app.route('/inventory', (await import('../server/routes/inventory')).inventoryRoutes);
app.route('/shipped', (await import('../server/routes/shipped')).shippedRoutes);
app.route('/perf', (await import('../server/routes/performance')).performanceRoutes);
const env = { DATABASE_URL: 'test' };
async function post(path: string, body: unknown) {
  const res = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
  if (res.status >= 300) throw new Error(`${path}: ${await res.text()}`);
  return res.json() as Promise<Record<string, number>>;
}
const get = async <T,>(path: string) => (await (await app.request(path, {}, env)).json()) as T;

const po = (over: Partial<ShipmentInput>): ShipmentInput => ({ supplier: 'ACME', poNumber: '0150001', lineRef: '1-1', poStatus: 'open', partNumber: 'A', branch: 'JIT-MSUS-META', quantity: 10, promisedArrivalDate: '2026-10-14', ...over });
async function importPo(reportDate: string, lines: ShipmentInput[]) {
  const keys = dedupeKeysForFile(lines);
  const { importId } = await post('/imports', { fileName: reportDate, reportDate, rowCount: lines.length });
  await post(`/imports/${importId}/rows`, { rows: lines.map((l, i) => ({ ...l, dedupeKey: keys[i] })) });
  await post(`/imports/${importId}/complete`, {});
}
const order = (over: Partial<OutboundOrderInput>): OutboundOrderInput => ({
  soNumber: 'SO1', emsPo: 'EMS1', status: 'Reserved Physical', warehouse: 'JIT-MSUS-META', shipTo: 'CELESTICA', cpn: 'A', mpn: null, manufacturer: null, businessGroup: null,
  packagingType: null, quantity: 5, totalPrice: null, sourceRows: 1, shipDate: '2026-10-14', shipDateSource: 'confirmed', scheduledShipDate: null, confirmedShipDate: '2026-10-14',
  dockDate: '2026-10-20', originalRequestDate: null, poReceiptDate: null, ...over,
});
async function importOrders(reportDate: string, orders: OutboundOrderInput[]) {
  const { snapshotId } = await post('/outbound/snapshots', { fileName: reportDate, reportDate, rowCount: orders.length, orderCount: orders.length, skippedQuotations: 0 });
  await post(`/outbound/snapshots/${snapshotId}/orders`, { orders });
  await post(`/outbound/snapshots/${snapshotId}/complete`, {});
}

describe('performance routes', () => {
  it('measures suppliers, our shipping and receiving from the uploads', { timeout: 30_000 }, async () => {
    ({ db } = await createTestDb());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T12:00:00'));
    try {
      // 10-10: two lines promised for 10-14. 10-18: one received on 10-17 (late), the other still open (past due).
      await importPo('2026-10-10', [po({}), po({ poNumber: '0150002', supplier: 'GOOD', promisedArrivalDate: '2026-10-20' })]);
      await importPo('2026-10-18', [po({ poStatus: 'closed' }), po({ poNumber: '0150002', supplier: 'GOOD', promisedArrivalDate: '2026-10-20' }), po({ poNumber: '0150003', promisedArrivalDate: '2026-10-12' })]);
      await post('/inventory/receipts', { reportDate: '2026-10-18', receipts: [{ poNumber: '0150001', poLine: '1', branch: 'JIT-MSUS-META', partNumber: 'A', receiptDate: '2026-10-17', arrivedDate: '2026-10-17', quantity: 10 }] });
      await importOrders('2026-10-10', [order({})]);
      await post('/shipped/rows', {
        reportDate: '2026-10-18',
        rows: [{ dedupeKey: 's1', shipTo: 'CELESTICA', odmPo: 'EMS1', odmPoLine: '10', partNumber: 'A', branch: 'JIT-MSUS-META', wintecPo: '0150001', quantity: 5, shipDate: '2026-10-17', soEtd: '2026-10-17', soEta: null, receiptDate: '2026-10-17', tracking: null }],
      });

      const s = await get<SupplierPerformanceResponse>('/perf/suppliers');
      expect(s.firstUpload).toBe('2026-10-10');
      expect(s.totals.arrival).toMatchObject({ count: 1, onTime: 0, medianDaysLate: 3 });
      expect(s.suppliers.find((x) => x.supplier === 'ACME')).toMatchObject({ arrival: { count: 1, onTimePct: 0 }, openLines: 1 });
      const detail = await get<SupplierDetailResponse>('/perf/suppliers/ACME');
      expect(detail.lines[0]).toMatchObject({ firstEta: '2026-10-14', arrived: '2026-10-17', arrivalDaysLate: 3 });

      const ship = await get<ShippingPerformanceResponse>('/perf/shipping');
      expect(ship).toMatchObject({ shipments: 1, matched: 1, firstOrderReport: '2026-10-10' });
      expect(ship.totals.vsConfirmed).toMatchObject({ count: 1, onTime: 0, medianDaysLate: 3 });
      expect(ship.totals.vsRequest).toMatchObject({ count: 1, onTime: 1 });
      expect(ship.totals.vsEtd).toMatchObject({ count: 1, onTime: 1 });

      const rec = await get<ReceivingResponse>('/perf/receiving');
      expect(rec.reports).toBe(2);
      expect(rec.pastDue.map((p) => [p.reportDate, p.lines])).toEqual([['2026-10-18', 1]]);
      expect(rec.current.map((c) => [c.poNumber, c.daysPastDue])).toEqual([['0150003', 17], ['0150002', 9]]);
      expect(rec.receiptToShip[0]).toMatchObject({ branch: 'JIT-MSUS-META', shipments: 1, medianDays: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
