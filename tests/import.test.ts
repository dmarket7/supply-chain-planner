import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { dedupeKeysForFile } from '../shared/importKeys';
import { guessMapping } from '../src/features/import/guessMapping';
import {
  detectCarrier,
  normalizeCarrier,
  normalizePoStatus,
  normalizeRow,
  parseTrackingCell,
  reportDateFromFileName,
  toIsoDate,
} from '../src/features/import/normalize';
import { headerSignature, parseSheet, readWorkbook } from '../src/features/import/parseWorkbook';

/** Headers of the Meerkat inventory report's "Supplier POs" tab. */
export const SUPPLIER_PO_HEADERS = [
  'POCreateDate', 'Branch', 'WarehouseLocation', 'Commodity', 'SIP', 'SupplierName', 'WintecPN', 'VendorPN',
  'Description', 'WintecPO', 'WintecPOLine', 'Meta PO', 'CRD', 'ETDDate', 'ETADate', 'POBuyPrice', 'POOrderQty',
  'ExtPOBuyPrice', 'POStatus', 'PackslipID', 'ASN', 'Tracking Num', 'Incoterm', 'META Special Instruction', 'COO',
  'Shipment Status', 'Ship From Location', 'Carrier',
];

const opts = { reportDate: '2026-10-10', closedWindowDays: 60 };

function workbookFrom(aoa: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Inbound');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return readWorkbook(buf);
}

describe('parseSheet', () => {
  it('skips title rows, finds headers, de-dupes header names and drops blank rows', () => {
    const wb = workbookFrom([
      ['Weekly Inbound Report'],
      ['Generated 10/17/2026'],
      ['Vendor', 'PO #', 'Tracking #', 'ETA', 'Notes', 'Notes'],
      ['Acme', 'PO-1', '1Z5R89390357567127', 46312, null, 'x'],
      [null, null, null, null, null, null],
      ['Globex', 'PO-2', null, '10/20/2026', null, null],
    ]);
    const sheet = parseSheet(wb, 'Inbound');
    expect(sheet.headerRowIndex).toBe(2);
    expect(sheet.headers).toEqual(['Vendor', 'PO #', 'Tracking #', 'ETA', 'Notes', 'Notes (2)']);
    expect(sheet.rows).toHaveLength(2);
  });

  it('builds a stable header signature', () => {
    expect(headerSignature(['PO #', 'Tracking Number'])).toBe('po|trackingnumber');
  });
});

describe('guessMapping', () => {
  it('maps the Supplier POs tab', () => {
    expect(guessMapping(SUPPLIER_PO_HEADERS)).toEqual({
      supplier: 'SupplierName',
      poNumber: 'WintecPO',
      lineRef: 'WintecPOLine',
      asn: 'ASN',
      poStatus: 'POStatus',
      trackingNumber: 'Tracking Num',
      carrier: 'Carrier',
      promisedArrivalDate: 'ETADate',
      shipDate: 'ETDDate',
      requestDate: 'CRD',
      customerPo: 'Meta PO',
      partNumber: 'WintecPN',
      itemDescription: 'Description',
      commodity: 'Commodity',
      warehouse: 'WarehouseLocation',
      quantity: 'POOrderQty',
    });
  });

  it('maps common generic header names', () => {
    expect(guessMapping(['Vendor Name', 'PO #', 'Ship Via', 'Tracking #', 'Ship Date', 'ETA', 'Actual Arrival Date', 'Qty'])).toEqual({
      supplier: 'Vendor Name',
      poNumber: 'PO #',
      carrier: 'Ship Via',
      trackingNumber: 'Tracking #',
      shipDate: 'Ship Date',
      promisedArrivalDate: 'ETA',
      actualArrivalDate: 'Actual Arrival Date',
      quantity: 'Qty',
    });
  });
});

describe('dates and statuses', () => {
  it.each([
    [46305, '2026-10-10'],
    ['2026-10-17', '2026-10-17'],
    ['10/17/2026', '2026-10-17'],
    ['17-Oct-2026', '2026-10-17'],
    ['Oct 17, 2026', '2026-10-17'],
    ['2/30/2026', null],
    ['TBD', null],
    [null, null],
  ])('toIsoDate(%s) -> %s', (input, expected) => {
    expect(toIsoDate(input as never)).toBe(expected);
  });

  it('reads the report date from the file name', () => {
    expect(reportDateFromFileName('Meerkat Wintec Inventory Report 20261010.xlsx')).toBe('2026-10-10');
    expect(reportDateFromFileName('report.xlsx')).toBeNull();
  });

  it('normalizes PO status', () => {
    expect(normalizePoStatus('Open')).toBe('open');
    expect(normalizePoStatus('Closed')).toBe('closed');
    expect(normalizePoStatus('')).toBeNull();
  });
});

describe('tracking cells and carriers', () => {
  it.each([
    ['878196053414', '878196053414', null, null],
    ['HKG19921086/IS20260944701', 'HKG19921086', 'IS20260944701', null],
    ['HKG-13920622/IS20251025302', 'HKG13920622', 'IS20251025302', null],
    ['9553962401/IS20260945178', '9553962401', 'IS20260945178', null],
    ['297-73979334', '297-73979334', null, null],
    ['LAX 971380', 'LAX971380', null, null],
    ['Truck', null, null, 'Truck'],
  ])('parses %s', (cell, trackingNumber, trackingRef, placeholder) => {
    expect(parseTrackingCell(cell)).toEqual({ trackingNumber, trackingRef, placeholder });
  });

  it.each([
    ['878196053414', 'FedEx', 'parcel'],
    ['6007213289', 'DHL', 'parcel'], // 10 digits, check digit not valid: shape-based guess
    ['3457463472', 'DHL', 'parcel'],
    ['1ZA74803E144317113', 'UPS', 'parcel'],
    ['297-73979334', 'China Airlines Cargo', 'freight'],
    ['555-12345678', 'Air cargo', 'freight'],
    ['HKG19921086', 'Forwarder', 'freight'],
    ['IS20260944532', null, null],
  ])('detects %s as %s', (tn, carrier, mode) => {
    expect(detectCarrier(tn)).toMatchObject({ carrier, mode });
  });

  it('normalizes named carriers', () => {
    expect(normalizeCarrier('United Parcel Service')).toMatchObject({ carrier: 'UPS', mode: 'parcel' });
    expect(normalizeCarrier('K&N')).toMatchObject({ carrier: 'Kuehne+Nagel', mode: 'freight' });
    expect(normalizeCarrier('DSV Air & Sea')).toMatchObject({ carrier: 'DSV', mode: 'freight' });
    expect(normalizeCarrier('Truck')).toMatchObject({ carrier: 'Truck', mode: 'freight' });
  });
});

describe('normalizeRow (Supplier POs)', () => {
  const mapping = guessMapping(SUPPLIER_PO_HEADERS);
  const row = (over: Record<string, string | number | null>) => ({
    ...Object.fromEntries(SUPPLIER_PO_HEADERS.map((h) => [h, null])),
    SupplierName: 'ACME MEMORY INC',
    WintecPO: '0150001',
    WintecPOLine: '1-1',
    POStatus: 'Open',
    POOrderQty: 100,
    ...over,
  });

  it('keeps an unshipped open line with no dates', () => {
    const r = normalizeRow(row({}), mapping, 2, opts);
    expect(r.errors).toEqual([]);
    expect(r.skipped).toBeNull();
    expect(r.shipment).toMatchObject({ poNumber: '0150001', lineRef: '1-1', poStatus: 'open', promisedArrivalDate: null, trackingNumber: null });
  });

  it('extracts ASN, tracking, carrier and dates from a shipped line', () => {
    const r = normalizeRow(
      row({ ASN: '26643676-1', 'Tracking Num': 'HKG19921086/IS20260944701', ETDDate: 46300, ETADate: 46305, CRD: 46298 }),
      mapping,
      3,
      opts,
    );
    expect(r.shipment).toMatchObject({
      asn: '26643676-1',
      trackingNumber: 'HKG19921086',
      trackingRef: 'IS20260944701',
      carrier: 'Forwarder',
      mode: 'freight',
      shipDate: '2026-10-05',
      promisedArrivalDate: '2026-10-10',
      requestDate: '2026-10-03',
    });
    expect(r.shipment?.sourceRow?.WintecPN).toBeNull();
  });

  it('skips closed lines outside the window or without ETA, and keeps recent ones', () => {
    expect(normalizeRow(row({ POStatus: 'Closed', ETADate: 46305 - 61 }), mapping, 4, opts).skipped).toMatch(/more than 60 days/);
    expect(normalizeRow(row({ POStatus: 'Closed' }), mapping, 5, opts).skipped).toBe('Closed line without an ETA');
    expect(normalizeRow(row({ POStatus: 'Closed', ETADate: 46305 - 20 }), mapping, 6, opts).shipment?.poStatus).toBe('closed');
  });

  it('ignores implausibly old ETAs with a warning', () => {
    const r = normalizeRow(row({ ETADate: 37312 }), mapping, 7, opts); // 2002-02-25
    expect(r.shipment?.promisedArrivalDate).toBeNull();
    expect(r.warnings[0]).toMatch(/more than 3 years/);
  });

  it('uses "Truck" in the tracking column as the carrier', () => {
    const r = normalizeRow(row({ 'Tracking Num': 'Truck', ETADate: 46306 }), mapping, 8, opts);
    expect(r.shipment).toMatchObject({ trackingNumber: null, carrier: 'Truck', mode: 'freight' });
  });

  it('requires a supplier', () => {
    expect(normalizeRow(row({ SupplierName: null }), mapping, 9, opts).errors).toEqual(['Missing supplier']);
  });
});

describe('normalizeRow (generic report without PO status)', () => {
  const mapping = { supplier: 'Vendor', poNumber: 'PO', trackingNumber: 'Tracking', promisedArrivalDate: 'ETA' };

  it('requires an ETA', () => {
    const r = normalizeRow({ Vendor: 'Acme', PO: 'P1', Tracking: null, ETA: 'soon' }, mapping, 2, opts);
    expect(r.errors).toEqual(['Missing ETA / promised arrival date']);
  });
});

describe('dedupeKeysForFile', () => {
  it('keys by PO + line + ASN and numbers repeats within a file', () => {
    expect(
      dedupeKeysForFile([
        { poNumber: '0157628', lineRef: '4-3', asn: '87851017' },
        { poNumber: '0157628', lineRef: '4-3', asn: '87851017' },
        { poNumber: '0157628', lineRef: '4-3', asn: null },
        { poNumber: null, lineRef: null, asn: null, trackingNumber: '1z 999' },
      ]),
    ).toEqual(['po:0157628:4-3:87851017', 'po:0157628:4-3:87851017#2', 'po:0157628:4-3:', 'trk:1Z999']);
  });
});
