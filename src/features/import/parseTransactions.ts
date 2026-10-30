import type * as XLSX from 'xlsx';
import type { ShippedOrderInput } from '../../../shared/types';
import { toIsoDate } from './normalize';
import { parseSheet, type Cell } from './parseWorkbook';
import { findSheet, norm, number, text } from './sheetColumns';

/** Columns of the Transactions tab (shipped sales order lines), matched by header. */
const COLUMNS = {
  shipDate: 'soshipdate',
  soEtd: 'soetddate',
  soEta: 'soetadate',
  receiptDate: 'inventoryreceiptdate',
  partNumber: 'wintecpn',
  branch: 'branch',
  shipTo: 'odm',
  odmPo: 'odmpo',
  odmPoLine: 'odmpoline',
  wintecPo: 'wintecpo',
  status: 'sostatus',
  tracking: 'tracking',
  quantity: 'soorderqty',
} as const;
type Column = keyof typeof COLUMNS;
const REQUIRED: Column[] = ['shipDate', 'partNumber', 'shipTo', 'odmPo'];

export function findTransactionsSheet(wb: XLSX.WorkBook): string | null {
  return findSheet(wb, REQUIRED.map((c) => COLUMNS[c]), /transaction/i);
}

export interface ParsedTransactions {
  sheetName: string;
  rowCount: number;
  rows: ShippedOrderInput[];
  /** Earliest and latest ship date. */
  from: string | null;
  to: string | null;
  errors: string[];
}

/**
 * Reads shipped sales order lines. A line that repeats within the file (same PO, line, part, ship
 * date and Wintec PO) gets "#2", "#3"… so each stays its own shipment; the key is stable across
 * reports because each report lists past shipments in the same order.
 */
export function parseTransactions(wb: XLSX.WorkBook, sheetName: string): ParsedTransactions {
  const sheet = parseSheet(wb, sheetName);
  const header = new Map(sheet.headers.map((h) => [norm(h), h]));
  const missing = REQUIRED.filter((c) => !header.has(COLUMNS[c]));
  if (missing.length) throw new Error(`"${sheetName}" is missing column${missing.length > 1 ? 's' : ''}: ${missing.map((c) => COLUMNS[c]).join(', ')}`);
  const get = (row: Record<string, Cell>, c: Column): Cell => {
    const h = header.get(COLUMNS[c]);
    return h ? (row[h] ?? null) : null;
  };

  const rows: ShippedOrderInput[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number>();
  sheet.rows.forEach((r, i) => {
    const status = text(get(r, 'status'));
    if (status && !/shipped/i.test(status)) return;
    const shipDate = toIsoDate(get(r, 'shipDate'));
    if (!shipDate) {
      errors.push(`Row ${sheet.headerRowIndex + i + 2}: no SOShipDate`);
      return;
    }
    const row = {
      shipTo: text(get(r, 'shipTo')),
      odmPo: text(get(r, 'odmPo')),
      odmPoLine: text(get(r, 'odmPoLine')),
      partNumber: text(get(r, 'partNumber')),
      branch: text(get(r, 'branch')),
      wintecPo: text(get(r, 'wintecPo')),
      quantity: number(get(r, 'quantity')),
      shipDate,
      soEtd: toIsoDate(get(r, 'soEtd')),
      soEta: toIsoDate(get(r, 'soEta')),
      receiptDate: toIsoDate(get(r, 'receiptDate')),
      tracking: text(get(r, 'tracking')),
    };
    const base = ['so', row.odmPo, row.odmPoLine, row.partNumber, row.shipDate, row.wintecPo].map((v) => v ?? '').join(':');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    rows.push({ ...row, dedupeKey: n === 1 ? base : `${base}#${n}` });
  });
  const dates = rows.map((r) => r.shipDate).sort();
  return { sheetName, rowCount: sheet.rows.length, rows, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null, errors };
}
