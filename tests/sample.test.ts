import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { guessMapping } from '../src/features/import/guessMapping';
import { normalizeRow } from '../src/features/import/normalize';
import { parseSheet, readWorkbook } from '../src/features/import/parseWorkbook';

const path = 'samples/inbound-sample.xlsx';

describe.runIf(existsSync(path))('generated sample report (npm run sample:xlsx)', () => {
  it('parses, maps and normalizes end to end', () => {
    const buf = readFileSync(path);
    const sheet = parseSheet(readWorkbook(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), 'Open POs');
    const mapping = guessMapping(sheet.headers);
    expect(mapping).toMatchObject({
      supplier: 'Vendor',
      poNumber: 'PO #',
      carrier: 'Ship Via',
      trackingNumber: 'Tracking #',
      promisedArrivalDate: 'Promised Date',
      actualArrivalDate: 'Date Received',
    });
    const rows = sheet.rows.map((r, i) => normalizeRow(r, mapping, i + 5));
    const errors = rows.filter((r) => r.errors.length);
    expect(errors.map((r) => r.errors)).toEqual([['Unreadable promised date "TBD"']]);
    expect(rows.flatMap((r) => r.shipments)).toHaveLength(8); // 7 valid rows, one split into two shipments
  });
});
