import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dedupeKeysForFile } from '../shared/importKeys';
import { guessMapping } from '../src/features/import/guessMapping';
import { normalizeRow, reportDateFromFileName } from '../src/features/import/normalize';
import { parseSheet, readWorkbook } from '../src/features/import/parseWorkbook';

const file = existsSync('samples') ? readdirSync('samples').find((f) => /^Sample Inventory Report \d{8}\.xlsx$/.test(f)) : undefined;

describe.runIf(file)('generated sample report (pnpm sample:xlsx)', () => {
  it('parses, maps and normalizes the Supplier POs tab end to end', () => {
    const buf = readFileSync(`samples/${file}`);
    const wb = readWorkbook(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    const sheet = parseSheet(wb, 'Supplier POs');
    const reportDate = reportDateFromFileName(file!)!;
    const rows = sheet.rows.map((r, i) => normalizeRow(r, guessMapping(sheet.headers), i + 2, { reportDate, closedWindowDays: 60 }));

    expect(rows.filter((r) => r.errors.length)).toEqual([]);
    expect(rows.filter((r) => r.skipped).map((r) => r.skipped)).toEqual([
      'Closed line with ETA more than 60 days before the report',
      'Closed line without an ETA',
    ]);
    const shipments = rows.flatMap((r) => (r.shipment ? [r.shipment] : []));
    expect(shipments).toHaveLength(14);
    expect(new Set(dedupeKeysForFile(shipments)).size).toBe(14);
    expect(shipments.filter((s) => s.poStatus === 'open' && !s.asn && !s.promisedArrivalDate)).toHaveLength(2);
  });
});
