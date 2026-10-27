import type * as XLSX from 'xlsx';
import type { PalletRatioFileRow } from '../../../shared/types';
import { parseSheet, type Cell } from '../import/parseWorkbook';

/**
 * Columns of the Pallet Ratios file, matched by header (case and punctuation ignored).
 * Quantity per truck and the price columns are formulas from these, so they aren't read.
 */
const COLUMNS = {
  partNumber: 'cpn',
  unitsPerPallet: 'standardorderqty',
  palletsPerTruck: 'pallettotruckratio',
  canDoubleStack: 'candoublestack',
  note: 'note1',
  itemName: 'itemname',
  productGroup: 'productgroup',
} as const;

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Positive number, or null for blanks, zeros and text. */
function ratio(v: Cell): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/,/g, '')) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function text(v: Cell): string | null {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
}

export interface ParsedRatios {
  sheetName: string;
  rows: PalletRatioFileRow[];
}

/** Reads the first sheet that has a CPN and a Standard Order Qty. column. */
export function parsePalletRatios(wb: XLSX.WorkBook): ParsedRatios {
  for (const name of wb.SheetNames) {
    const sheet = parseSheet(wb, name);
    const header = new Map(sheet.headers.map((h) => [norm(h), h]));
    if (!header.has(COLUMNS.partNumber) || !header.has(COLUMNS.unitsPerPallet)) continue;
    const get = (row: Record<string, Cell>, key: keyof typeof COLUMNS) => {
      const h = header.get(COLUMNS[key]);
      return h ? row[h] : null;
    };
    const rows = sheet.rows
      .map((r) => ({
        partNumber: text(get(r, 'partNumber')) ?? '',
        unitsPerPallet: ratio(get(r, 'unitsPerPallet')),
        palletsPerTruck: ratio(get(r, 'palletsPerTruck')),
        canDoubleStack: /^y/i.test(text(get(r, 'canDoubleStack')) ?? ''),
        note: text(get(r, 'note')),
        itemName: text(get(r, 'itemName')),
        productGroup: text(get(r, 'productGroup')),
      }))
      .filter((r) => r.partNumber);
    return { sheetName: name, rows };
  }
  throw new Error('No sheet with "CPN" and "Standard Order Qty." columns was found in this file.');
}
