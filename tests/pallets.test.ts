import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../server/env';
import type { Db } from '../server/db/client';
import { palletRatios } from '../server/db/schema';
import { addLine, emptySummary, RatioLookup, toPallets, type PalletRatio } from '../shared/pallets';
import type { InboundResponse, PalletRatioFileRow, PalletRatioImportResult, PalletRatiosResponse } from '../shared/types';
import { createTestDb, seedShipments } from './helpers/testDb';

const ratio = (partNumber: string, unitsPerPallet: number | null, productGroup = 'SSD', palletsPerTruck: number | null = 26): PalletRatio => ({
  partNumber,
  unitsPerPallet,
  palletsPerTruck,
  productGroup,
  source: 'file',
});

describe('ratio lookup', () => {
  const lookup = new RatioLookup([
    ratio('SSD-1', 1200),
    ratio('SSD-2', 960),
    ratio('SSD-3', 3200, 'ssd'),
    ratio('SSD-BLANK', null, 'SSD', 14),
    ratio('NET-1', 9, 'Network'),
    ratio('NET-2', 432, 'Network'),
  ]);

  it('uses the part\'s own ratio when it has one', () => {
    expect(lookup.resolve('SSD-1', 'SSD')).toEqual({ basis: 'real', unitsPerPallet: 1200, palletsPerTruck: 26, palletsPerTruckBasis: 'real' });
  });

  it('estimates from the commodity median, case-insensitively, keeping a known pallets-per-truck', () => {
    expect(lookup.resolve('SSD-BLANK', null)).toEqual({
      basis: 'estimated',
      unitsPerPallet: 1200,
      palletsPerTruck: 14,
      palletsPerTruckBasis: 'real',
      estimate: { commodity: 'SSD', parts: 3 },
    });
    expect(lookup.resolve('UNLISTED', 'ssd ').unitsPerPallet).toBe(1200);
  });

  it('has no ratio when the commodity has no real ratios', () => {
    expect(lookup.resolve('HDD-1', 'HDD')).toMatchObject({ basis: 'none', unitsPerPallet: null });
    expect(lookup.resolve(null, null).basis).toBe('none');
  });

  it('flags commodities whose ratios differ widely, with an even-count median', () => {
    const net = lookup.estimates.find((e) => e.commodity === 'Network')!;
    expect(net).toMatchObject({ unitsPerPallet: 220.5, parts: 2, min: 9, max: 432, wideSpread: true });
    expect(lookup.estimates.find((e) => e.commodity === 'SSD')!.wideSpread).toBe(false);
  });
});

describe('pallet math', () => {
  const real = { basis: 'real' as const, unitsPerPallet: 840, palletsPerTruck: 26, palletsPerTruckBasis: 'real' as const };

  it('keeps pallets fractional and counts whole and partial pallets per line', () => {
    expect(toPallets(real, 2000)).toMatchObject({ fullPallets: 2, partial: true });
    expect(toPallets(real, 2000).palletEq).toBeCloseTo(2.381, 3);
    expect(toPallets(real, 1680)).toMatchObject({ palletEq: 2, fullPallets: 2, partial: false });
    expect(toPallets(real, 100)).toMatchObject({ fullPallets: 0, partial: true });
    expect(toPallets(real, 0)).toMatchObject({ palletEq: 0, fullPallets: 0, partial: false });
  });

  it('handles fractional ratios and floating-point remainders', () => {
    expect(toPallets({ ...real, unitsPerPallet: 0.15 }, 3)).toMatchObject({ fullPallets: 20, partial: false });
    expect(toPallets({ ...real, unitsPerPallet: 0.1 }, 0.3)).toMatchObject({ fullPallets: 3, partial: false });
  });

  it('sums real, estimated and no-ratio lines separately', () => {
    const sum = emptySummary();
    addLine(sum, toPallets(real, 2000), 2000);
    addLine(sum, toPallets({ basis: 'estimated', unitsPerPallet: 100, palletsPerTruck: 26, palletsPerTruckBasis: 'default' }, 150), 150);
    addLine(sum, toPallets({ basis: 'none', unitsPerPallet: null, palletsPerTruck: 26, palletsPerTruckBasis: 'default' }, 40), 40);
    addLine(sum, toPallets(real, 0), null);
    expect(sum).toMatchObject({
      lines: 4,
      units: 2190,
      fullPallets: 3,
      partialPallets: 2,
      estimatedPalletEq: 1.5,
      estimatedLines: 1,
      noRatioLines: 1,
      noRatioUnits: 40,
    });
    expect(sum.realPalletEq).toBeCloseTo(2.381, 3);
    expect(sum.palletEq).toBeCloseTo(3.881, 3);
  });
});

let db: Db;
vi.mock('../server/db/client', () => ({ getDb: () => db }));
const routes = (await import('../server/routes/palletRatios')).palletRatiosRoutes;
// Stands in for requireAuth, which sets the signed-in user.
const palletRatiosRoutes = new Hono<AppEnv>().use('*', async (c, next) => { c.set('userId', 'tester'); await next(); }).route('/', routes);
const { reportsRoutes } = await import('../server/routes/reports');

const env = { DATABASE_URL: 'test' };
const json = { 'Content-Type': 'application/json' };
const fileRow = (partNumber: string, unitsPerPallet: number | null, over: Partial<PalletRatioFileRow> = {}): PalletRatioFileRow => ({
  partNumber,
  unitsPerPallet,
  palletsPerTruck: 26,
  canDoubleStack: false,
  note: null,
  itemName: `Item ${partNumber}`,
  productGroup: 'SSD',
  ...over,
});
const upload = async (rows: PalletRatioFileRow[], dryRun = false) =>
  (await (await palletRatiosRoutes.request('/import', { method: 'POST', headers: json, body: JSON.stringify({ rows, dryRun }) }, env)).json()) as PalletRatioImportResult;
const list = async () => (await (await palletRatiosRoutes.request('/', {}, env)).json()) as PalletRatiosResponse;

describe('pallet ratio settings', () => {
  beforeEach(async () => {
    ({ db } = await createTestDb());
  });

  it('previews an upload without writing, then imports it', async () => {
    const preview = await upload([fileRow('A', 1200), fileRow('B', null), fileRow('A', 1000)], true);
    expect(preview).toMatchObject({ dryRun: true, total: 2, added: 2, missing: 1 });
    expect(await db.select().from(palletRatios)).toHaveLength(0);

    await upload([fileRow('A', 1200), fileRow('B', null)]);
    const again = await upload([fileRow('A', 1200), fileRow('B', null, { note: 'Issues with SOQ' })], true);
    expect(again).toMatchObject({ added: 0, changed: 1, unchanged: 1 });
  });

  it('keeps manual edits over later uploads and reports the disagreement', async () => {
    await upload([fileRow('A', 1200)]);
    const put = await palletRatiosRoutes.request('/A', { method: 'PUT', headers: json, body: JSON.stringify({ unitsPerPallet: 1000, palletsPerTruck: 26 }) }, env);
    expect(put.status).toBe(200);

    const result = await upload([fileRow('A', 1440)]);
    expect(result.conflicts).toEqual([{ partNumber: 'A', manual: { unitsPerPallet: 1000, palletsPerTruck: 26 }, file: { unitsPerPallet: 1440, palletsPerTruck: 26 } }]);
    let row = (await list()).rows.find((r) => r.partNumber === 'A')!;
    expect(row).toMatchObject({ source: 'manual', unitsPerPallet: 1000, conflict: true, basis: 'real' });

    await palletRatiosRoutes.request('/A/manual', { method: 'DELETE' }, env);
    row = (await list()).rows.find((r) => r.partNumber === 'A')!;
    expect(row).toMatchObject({ source: 'file', unitsPerPallet: 1440, conflict: false });
  });

  it('rejects zero or negative ratios', async () => {
    const res = await palletRatiosRoutes.request('/A', { method: 'PUT', headers: json, body: JSON.stringify({ unitsPerPallet: 0, palletsPerTruck: null }) }, env);
    expect(res.status).toBe(400);
  });

  it('lists parts seen in shipments that have no ratio, with their open inbound', async () => {
    await upload([fileRow('A', 1000)]);
    await seedShipments(db, [
      { partNumber: 'X', commodity: 'SSD', quantity: 500 },
      { partNumber: 'X', commodity: 'SSD', quantity: 100, actualArrivalDate: '2026-10-01' },
      { partNumber: 'Y', commodity: 'HDD', quantity: 10 },
    ]);
    const { rows, estimates } = await list();
    expect(rows.map((r) => [r.partNumber, r.basis, r.source, r.openLines, r.openUnits])).toEqual([
      ['A', 'real', 'file', 0, 0],
      ['X', 'estimated', null, 1, 500],
      ['Y', 'none', null, 1, 10],
    ]);
    expect(rows[1]).toMatchObject({ effectiveUnitsPerPallet: 1000, estimate: { commodity: 'SSD', parts: 1 } });
    expect(estimates).toHaveLength(1);
  });
});

describe('inbound report in pallets', () => {
  beforeEach(async () => {
    ({ db } = await createTestDb());
  });

  it('adds pallet summaries per day and per part', async () => {
    await upload([fileRow('A', 840)]);
    await seedShipments(db, [
      { partNumber: 'A', commodity: 'SSD', quantity: 2000, promisedArrivalDate: '2026-10-21' },
      { partNumber: 'B', commodity: 'SSD', quantity: 420, promisedArrivalDate: '2026-10-21' },
      { partNumber: 'C', commodity: 'HDD', quantity: 50, promisedArrivalDate: '2026-10-22' },
    ]);
    const res = await reportsRoutes.request('/inbound-by-day?from=2026-10-20&to=2026-10-25', {}, env);
    const body = (await res.json()) as InboundResponse;

    expect(body.days.map((d) => d.date)).toEqual(['2026-10-21', '2026-10-22']);
    expect(body.days[0].pallets).toMatchObject({ lines: 2, fullPallets: 2, partialPallets: 2, estimatedPalletEq: 0.5 });
    expect(body.days[0].shipments.find((s) => s.partNumber === 'B')!.pallets).toMatchObject({ basis: 'estimated', palletEq: 0.5 });
    expect(body.days[1].pallets).toMatchObject({ palletEq: 0, noRatioLines: 1, noRatioUnits: 50 });
    expect(body.parts.map((p) => [p.partNumber, p.basis])).toEqual([['A', 'real'], ['B', 'estimated'], ['C', 'none']]);
  });
});

describe('reading the Pallet Ratios file', () => {
  it('reads ratios by header, ignoring blanks, zeros and formula columns', async () => {
    const XLSX = await import('xlsx');
    const { parsePalletRatios } = await import('../src/features/settings/parsePalletRatios');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Notes']]), 'Readme');
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['CPN', 'Pallet to truck ratio', 'Standard Order Qty.', 'Price per item', 'Quantity per truck', 'Price per truck', 'Can double stack?', 'Note 1', 'Item Name', 'Product Group'],
        ['MET-000003', 26, 840, 132, 21840, 2882880, '', '', 'NIC 50G', 'NIC'],
        ['MET-000001', '', '', '', 0, 0, '', '', 'PM9A2 256GB', 'SSD'],
        ['MET-000121', 26, '', '', 0, 0, 'YES', 'Issues with SOQ', 'Cable', 'CABLE'],
        ['', '', '', '', 0, 0, '', '', '', ''],
      ]),
      'Pallet truck ratios',
    );
    const { sheetName, rows } = parsePalletRatios(wb);
    expect(sheetName).toBe('Pallet truck ratios');
    expect(rows).toEqual([
      { partNumber: 'MET-000003', unitsPerPallet: 840, palletsPerTruck: 26, canDoubleStack: false, note: null, itemName: 'NIC 50G', productGroup: 'NIC' },
      { partNumber: 'MET-000001', unitsPerPallet: null, palletsPerTruck: null, canDoubleStack: false, note: null, itemName: 'PM9A2 256GB', productGroup: 'SSD' },
      { partNumber: 'MET-000121', unitsPerPallet: null, palletsPerTruck: 26, canDoubleStack: true, note: 'Issues with SOQ', itemName: 'Cable', productGroup: 'CABLE' },
    ]);
  });
});
