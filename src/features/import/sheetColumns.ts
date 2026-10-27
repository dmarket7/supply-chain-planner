import * as XLSX from 'xlsx';
import { detectHeaderRow, type Cell } from './parseWorkbook';

/** Fixed-format tabs are matched by header, ignoring case and punctuation. */
export const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export function text(v: Cell): string | null {
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
  return s ? s : null;
}

export function number(v: Cell): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/,/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Headers of the first rows only, so finding a tab doesn't parse every sheet. */
function headersOf(ws: XLSX.WorkSheet): Set<string> {
  if (!ws?.['!ref']) return new Set();
  const range = XLSX.utils.decode_range(ws['!ref']);
  range.e.r = Math.min(range.e.r, range.s.r + 20);
  const grid = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, range, defval: null, blankrows: false });
  return new Set((grid[detectHeaderRow(grid)] ?? []).map((h) => norm(String(h ?? ''))));
}

/** The first sheet with all the headers, trying sheets whose name matches `preferName` first. */
export function findSheet(wb: XLSX.WorkBook, headers: string[], preferName: RegExp): string | null {
  const names = [...wb.SheetNames].sort((a, b) => Number(!preferName.test(a)) - Number(!preferName.test(b)));
  return names.find((n) => {
    const h = headersOf(wb.Sheets[n]);
    return headers.every((c) => h.has(c));
  }) ?? null;
}
