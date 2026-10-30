import type * as XLSX from 'xlsx';
import { isHeldBranch } from '../../../shared/supply';
import type { InventoryPositionInput, ReceiptInput } from '../../../shared/types';
import { toIsoDate } from './normalize';
import { parseSheet, type Cell } from './parseWorkbook';
import { findSheet, norm, number, text } from './sheetColumns';

/** Columns of the Inventory Summary tab, matched by header (case and punctuation ignored). */
const COLUMNS = {
  partNumber: 'wintecpn',
  branch: 'branch',
  onhand: 'onhandqty',
  available: 'availableqty',
  reserved: 'reservedqty',
  allocated: 'allocatedqty',
  onReceipt: 'onreceipt',
  status: 'invstatus',
  vendorPn: 'vendorpn',
  description: 'description',
  commodity: 'commodity',
  receivedDate: 'materialrecdate',
  arrivedDate: 'actualreceivedate',
  poNumber: 'wintecpo',
  poLine: 'wintecpoline',
  poQty: 'poqty',
} as const;
type Column = keyof typeof COLUMNS;
const REQUIRED: Column[] = ['partNumber', 'branch', 'onhand', 'available'];
const QUANTITIES = ['onhand', 'reserved', 'allocated', 'available', 'onReceipt'] as const;

/** The Inventory Summary tab: by name first (Sourcing Manager Detail has the same columns), else any sheet with the required columns. */
export function findInventorySheet(wb: XLSX.WorkBook): string | null {
  return findSheet(wb, REQUIRED.map((c) => COLUMNS[c]), /inventory\s*summary/i);
}

export interface ParsedInventory {
  sheetName: string;
  rowCount: number;
  /** Fully shipped lots, left out. */
  closedRows: number;
  positions: InventoryPositionInput[];
  parts: number;
  /** On hand in quarantine, RMA, cycle-count and in-transit branches. */
  heldUnits: number;
  /** Every received lot, open or closed, summed per PO line, branch and receipt date. */
  receipts: ReceiptInput[];
  errors: string[];
}

/**
 * Reads stock per part and branch. The tab has one row per received PO lot; open lots are summed,
 * which also nets out transfers between branches (a negative and a positive row).
 */
export function parseInventorySummary(wb: XLSX.WorkBook, sheetName: string): ParsedInventory {
  const sheet = parseSheet(wb, sheetName);
  const header = new Map(sheet.headers.map((h) => [norm(h), h]));
  const missing = REQUIRED.filter((c) => !header.has(COLUMNS[c]));
  if (missing.length) {
    throw new Error(`"${sheetName}" is missing column${missing.length > 1 ? 's' : ''}: ${missing.map((c) => COLUMNS[c]).join(', ')}`);
  }
  const get = (row: Record<string, Cell>, c: Column): Cell => {
    const h = header.get(COLUMNS[c]);
    return h ? (row[h] ?? null) : null;
  };

  const positions = new Map<string, InventoryPositionInput>();
  const receipts = new Map<string, ReceiptInput>();
  const errors: string[] = [];
  let closedRows = 0;
  sheet.rows.forEach((r, i) => {
    const receipt = receiptOf(r, get);
    if (receipt) {
      const key = [receipt.poNumber, receipt.poLine, receipt.branch, receipt.receiptDate].join('\u0000');
      const prev = receipts.get(key);
      if (!prev) receipts.set(key, receipt);
      else {
        prev.quantity = prev.quantity === null && receipt.quantity === null ? null : (prev.quantity ?? 0) + (receipt.quantity ?? 0);
        prev.arrivedDate ??= receipt.arrivedDate;
        prev.partNumber ??= receipt.partNumber;
      }
    }
    if (/closed/i.test(text(get(r, 'status')) ?? '')) {
      closedRows++;
      return;
    }
    const partNumber = text(get(r, 'partNumber'));
    const branch = text(get(r, 'branch'));
    if (!partNumber || !branch) {
      errors.push(`Row ${sheet.headerRowIndex + i + 2}: no ${partNumber ? 'Branch' : 'WintecPN'}`);
      return;
    }
    const qty = Object.fromEntries(QUANTITIES.map((q) => [q, number(get(r, q)) ?? 0])) as Record<(typeof QUANTITIES)[number], number>;
    const received = qty.onhand > 0 ? toIsoDate(get(r, 'receivedDate')) : null;
    const key = `${partNumber}\u0000${branch}`;
    const prev = positions.get(key);
    if (!prev) {
      positions.set(key, {
        partNumber,
        branch,
        vendorPn: text(get(r, 'vendorPn')),
        description: text(get(r, 'description')),
        commodity: text(get(r, 'commodity')),
        ...qty,
        oldestReceiptDate: received,
        sourceRows: 1,
      });
      return;
    }
    for (const q of QUANTITIES) prev[q] += qty[q];
    if (received && (!prev.oldestReceiptDate || received < prev.oldestReceiptDate)) prev.oldestReceiptDate = received;
    prev.sourceRows++;
    for (const k of ['vendorPn', 'description', 'commodity'] as const) prev[k] ??= text(get(r, k));
  });

  const list = [...positions.values()];
  return {
    sheetName,
    rowCount: sheet.rows.length,
    closedRows,
    positions: list,
    parts: new Set(list.map((p) => p.partNumber)).size,
    heldUnits: list.filter((p) => isHeldBranch(p.branch)).reduce((n, p) => n + p.onhand, 0),
    receipts: [...receipts.values()],
    errors,
  };
}

/** A received lot: needs a PO, line, branch and MaterialRecDate. */
function receiptOf(r: Record<string, Cell>, get: (row: Record<string, Cell>, c: Column) => Cell): ReceiptInput | null {
  const poNumber = text(get(r, 'poNumber'));
  const poLine = text(get(r, 'poLine'));
  const branch = text(get(r, 'branch'));
  const receiptDate = toIsoDate(get(r, 'receivedDate'));
  if (!poNumber || !poLine || !branch || !receiptDate) return null;
  return {
    poNumber,
    poLine,
    branch,
    partNumber: text(get(r, 'partNumber')),
    receiptDate,
    arrivedDate: toIsoDate(get(r, 'arrivedDate')),
    quantity: number(get(r, 'poQty')),
  };
}
