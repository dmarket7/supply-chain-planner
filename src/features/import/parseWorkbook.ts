import * as XLSX from 'xlsx';

export type Cell = string | number | boolean | null;

export interface ParsedSheet {
  name: string;
  headerRowIndex: number;
  headers: string[];
  /** Data rows keyed by header. */
  rows: Record<string, Cell>[];
}

export function readWorkbook(data: ArrayBuffer): XLSX.WorkBook {
  // Dates stay as Excel serial numbers; normalize.ts converts them for date-mapped columns
  // only, which avoids the timezone shifts JS Date conversion can introduce.
  return XLSX.read(data, { type: 'array' });
}

/** First row with at least 3 non-empty text cells; report title rows above it are skipped. */
export function detectHeaderRow(grid: Cell[][]): number {
  const idx = grid.findIndex(
    (row) => row.filter((c) => typeof c === 'string' && c.trim() !== '').length >= 3,
  );
  return idx === -1 ? 0 : idx;
}

export function parseSheet(wb: XLSX.WorkBook, sheetName: string): ParsedSheet {
  const ws = wb.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, defval: null, blankrows: false });
  const headerRowIndex = detectHeaderRow(grid);

  const seen = new Map<string, number>();
  const headers = (grid[headerRowIndex] ?? []).map((h, i) => {
    let name = h == null || String(h).trim() === '' ? `Column ${i + 1}` : String(h).trim();
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n > 0) name = `${name} (${n + 1})`;
    return name;
  });

  const rows = grid
    .slice(headerRowIndex + 1)
    .filter((r) => r.some((c) => c !== null && String(c).trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? null])));

  return { name: sheetName, headerRowIndex, headers, rows };
}

/** Stable fingerprint of a sheet layout so a saved mapping can be re-applied automatically. */
export function headerSignature(headers: string[]): string {
  return headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, '')).join('|');
}
