import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { guessMapping } from '../src/features/import/guessMapping';
import {
  detectCarrier,
  normalizeCarrier,
  normalizeRow,
  splitTrackingNumbers,
  toIsoDate,
} from '../src/features/import/normalize';
import { headerSignature, parseSheet, readWorkbook } from '../src/features/import/parseWorkbook';

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
    expect(sheet.rows[0]['Tracking #']).toBe('1Z5R89390357567127');
  });

  it('builds a stable header signature', () => {
    expect(headerSignature(['PO #', 'Tracking Number'])).toBe('po|trackingnumber');
  });
});

describe('guessMapping', () => {
  it('maps common header names', () => {
    expect(
      guessMapping(['Vendor Name', 'PO #', 'Line', 'Ship Via', 'Tracking #', 'Ship Date', 'ETA', 'Actual Arrival Date', 'Qty']),
    ).toEqual({
      supplier: 'Vendor Name',
      poNumber: 'PO #',
      lineRef: 'Line',
      carrier: 'Ship Via',
      trackingNumber: 'Tracking #',
      shipDate: 'Ship Date',
      promisedArrivalDate: 'ETA',
      actualArrivalDate: 'Actual Arrival Date',
      quantity: 'Qty',
    });
  });

  it('prefers the more specific field for overlapping names', () => {
    const m = guessMapping(['Supplier', 'Promised Arrival Date (Supplier)', 'Actual Arrival Date']);
    expect(m.actualArrivalDate).toBe('Actual Arrival Date');
    expect(m.promisedArrivalDate).toBe('Promised Arrival Date (Supplier)');
  });
});

describe('toIsoDate', () => {
  it.each([
    [46312, '2026-10-17'],
    ['2026-10-17', '2026-10-17'],
    ['10/17/2026', '2026-10-17'],
    ['10/17/26', '2026-10-17'],
    ['17-Oct-2026', '2026-10-17'],
    ['Oct 17, 2026', '2026-10-17'],
    ['2/30/2026', null],
    ['TBD', null],
    [null, null],
  ])('%s -> %s', (input, expected) => {
    expect(toIsoDate(input as never)).toBe(expected);
  });
});

describe('tracking numbers and carriers', () => {
  it('splits multi-value cells and strips spaces', () => {
    expect(splitTrackingNumbers('1z5r 8939 0357 567127, 1Z5R89390357567127\n9999')).toEqual([
      '1Z5R89390357567127',
      '1Z5R89390357567127',
      '9999',
    ]);
  });

  it('normalizes carrier names and infers mode', () => {
    expect(normalizeCarrier('United Parcel Service')).toEqual({ carrier: 'UPS', mode: 'parcel' });
    expect(normalizeCarrier('Federal Express')).toEqual({ carrier: 'FedEx', mode: 'parcel' });
    expect(normalizeCarrier('Old Dominion Freight Line')).toEqual({ carrier: 'Old Dominion Freight Line', mode: 'ltl' });
  });

  it('detects UPS from a valid 1Z number', () => {
    expect(detectCarrier('1Z5R89390357567127')).toBe('UPS');
    expect(detectCarrier('NOTATRACKINGNUMBER')).toBeNull();
  });
});

describe('normalizeRow', () => {
  const mapping = {
    supplier: 'Vendor',
    poNumber: 'PO',
    trackingNumber: 'Tracking',
    carrier: 'Carrier',
    promisedArrivalDate: 'ETA',
  };

  it('produces one shipment per tracking number with detected carrier', () => {
    const r = normalizeRow(
      { Vendor: 'Acme', PO: 'PO-1', Tracking: '1Z5R89390357567127; 1Z5R89390357567127', Carrier: null, ETA: '10/20/2026' },
      mapping,
      4,
    );
    expect(r.errors).toEqual([]);
    expect(r.shipments).toHaveLength(2);
    expect(r.shipments[0]).toMatchObject({ supplier: 'Acme', carrier: 'UPS', mode: 'parcel', promisedArrivalDate: '2026-10-20' });
  });

  it('keeps the listed LTL carrier and PRO number', () => {
    const r = normalizeRow({ Vendor: 'Acme', PO: 'PO-2', Tracking: '123-456-789', Carrier: 'Estes Express', ETA: 46312 }, mapping, 5);
    expect(r.shipments[0]).toMatchObject({ carrier: 'Estes Express', mode: 'ltl', trackingNumber: '123456789' });
  });

  it('reports errors for missing required data', () => {
    const r = normalizeRow({ Vendor: null, PO: null, Tracking: null, Carrier: null, ETA: 'soon' }, mapping, 6);
    expect(r.shipments).toEqual([]);
    expect(r.errors).toEqual([
      'Missing supplier',
      'Unreadable promised date "soon"',
      'Needs a tracking number or a PO number',
    ]);
  });
});
