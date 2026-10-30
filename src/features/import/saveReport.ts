import type { WorkBook } from 'xlsx';
import { dedupeKeysForFile } from '../../../shared/importKeys';
import {
  IMPORT_CHUNK_SIZE,
  type SavedMapping,
  INVENTORY_CHUNK_SIZE,
  OUTBOUND_CHUNK_SIZE,
  RECEIPT_CHUNK_SIZE,
  SHIPPED_CHUNK_SIZE,
  type ImportResult,
  type InventorySnapshotInfo,
  type OutboundSnapshotInfo,
  type ShipmentInput,
} from '../../../shared/types';
import { guessMapping, mappingComplete } from './guessMapping';
import { normalizeRow } from './normalize';
import { findInventorySheet, parseInventorySummary, type ParsedInventory } from './parseInventorySummary';
import { findOdmSheet, parseOdmOrders, type ParsedOdmOrders } from './parseOdmOrders';
import { findTransactionsSheet, parseTransactions, type ParsedTransactions } from './parseTransactions';
import { headerSignature, parseSheet, readWorkbook } from './parseWorkbook';
import { postChunks, uploadChunked } from './uploadChunked';

/*
 * Reading a Meerkat report's tabs and saving each one, shared by the single and bulk imports.
 */

/** The tab that holds inbound PO lines in the Meerkat report; other reports fall back to the first sheet. */
export const PREFERRED_SHEET = /supplier\s*po/i;
export const poSheetName = (wb: WorkBook) => wb.SheetNames.find((n) => PREFERRED_SHEET.test(n)) ?? wb.SheetNames[0];

/** The tabs one import covers, in the order they're saved. */
export const STEPS = ['po', 'outbound', 'inventory', 'shipped'] as const;
export type Step = (typeof STEPS)[number];
export const STEP_TITLES: Record<Step, string> = { po: 'Supplier POs', outbound: 'ODM open orders', inventory: 'Inventory', shipped: 'Shipped orders (Transactions)' };

export type Progress = (done: number, total: number) => void;

/** A tab read with its own parser; error is set when the tab is there but couldn't be read. */
export interface Tab<T> {
  parsed: T | null;
  error: string | null;
}
export const NO_TAB = { parsed: null, error: null };

export function readTab<T>(name: string | null, parse: (name: string) => T): Tab<T> {
  if (!name) return NO_TAB;
  try {
    return { parsed: parse(name), error: null };
  } catch (e) {
    return { parsed: null, error: `Couldn't read the ${name} tab: ${e instanceof Error ? e.message : e}` };
  }
}

export interface OtherTabs {
  odm: Tab<ParsedOdmOrders>;
  inventory: Tab<ParsedInventory>;
  transactions: Tab<ParsedTransactions>;
}

/** The ODM Open Order, Inventory Summary and Transactions tabs, when the workbook has them. */
export const readOtherTabs = (wb: WorkBook): OtherTabs => ({
  odm: readTab(findOdmSheet(wb), (n) => parseOdmOrders(wb, n)),
  inventory: readTab(findInventorySheet(wb), (n) => parseInventorySummary(wb, n)),
  transactions: readTab(findTransactionsSheet(wb), (n) => parseTransactions(wb, n)),
});

export function savePoLines(
  opts: { fileName: string | null; sheetName?: string; reportDate: string; mappingId: number | null; shipments: ShipmentInput[] },
  onProgress: Progress,
): Promise<ImportResult> {
  const keys = dedupeKeysForFile(opts.shipments);
  const rows = opts.shipments.map((s, i) => ({ ...s, dedupeKey: keys[i] }));
  return uploadChunked<ImportResult>({
    base: '/imports',
    start: { fileName: opts.fileName, sheetName: opts.sheetName, reportDate: opts.reportDate, mappingId: opts.mappingId, rowCount: rows.length },
    idKey: 'importId',
    chunkPath: 'rows',
    field: 'rows',
    items: rows,
    size: IMPORT_CHUNK_SIZE,
    onProgress,
  });
}

export function saveOdmOrders(p: ParsedOdmOrders, fileName: string | null, reportDate: string, onProgress: Progress): Promise<OutboundSnapshotInfo> {
  return uploadChunked<OutboundSnapshotInfo>({
    base: '/outbound/snapshots',
    start: { fileName, reportDate, rowCount: p.rowCount, orderCount: p.orders.length, skippedQuotations: p.skippedQuotations },
    idKey: 'snapshotId',
    chunkPath: 'orders',
    field: 'orders',
    items: p.orders,
    size: OUTBOUND_CHUNK_SIZE,
    onProgress,
  });
}

/** The stock positions, then every received lot. */
export async function saveInventory(p: ParsedInventory, fileName: string | null, reportDate: string, onProgress: Progress): Promise<InventorySnapshotInfo> {
  const result = await uploadChunked<InventorySnapshotInfo>({
    base: '/inventory/snapshots',
    start: { fileName, reportDate, rowCount: p.rowCount, positionCount: p.positions.length },
    idKey: 'snapshotId',
    chunkPath: 'positions',
    field: 'positions',
    items: p.positions,
    size: INVENTORY_CHUNK_SIZE,
    onProgress,
  });
  await postChunks({ path: '/inventory/receipts', field: 'receipts', items: p.receipts, size: RECEIPT_CHUNK_SIZE, extra: { reportDate }, onProgress });
  return result;
}

export function saveShipped(p: ParsedTransactions, reportDate: string, onProgress: Progress): Promise<void> {
  return postChunks({ path: '/shipped/rows', field: 'rows', items: p.rows, size: SHIPPED_CHUNK_SIZE, extra: { reportDate }, onProgress });
}

/** Same closed-line window as the single import's default. */
const CLOSED_WINDOW_DAYS = 60;

export interface ReportFileResult {
  /** What was saved, e.g. "4,126 PO lines · 1,203 sales orders". */
  saved: string[];
  /** Tabs or rows left out. */
  notes: string[];
  /** An older or same-date Supplier POs report was kept: the inbound history needs a rebuild. */
  needsRebuild: boolean;
}

/**
 * Reads one report and saves every tab it has, Supplier POs first, with the saved column mapping
 * for its headers (else the guessed one). Throws on the first tab that fails to save.
 */
export async function importReportFile(
  data: ArrayBuffer,
  opts: { fileName: string; reportDate: string; mappings: SavedMapping[] },
  onStep: (step: Step, done?: number, total?: number) => void,
): Promise<ReportFileResult> {
  const { fileName, reportDate } = opts;
  const wb = readWorkbook(data);
  const sheet = parseSheet(wb, poSheetName(wb));
  const saved = opts.mappings.find((m) => m.headerSignature === headerSignature(sheet.headers));
  const mapping = saved?.mapping ?? guessMapping(sheet.headers);
  const rows = sheet.rows.map((r, i) => normalizeRow(r, mapping, sheet.headerRowIndex + i + 2, { reportDate, closedWindowDays: CLOSED_WINDOW_DAYS }));
  const shipments = rows.flatMap((r) => (r.shipment ? [r.shipment] : []));
  const { odm, inventory, transactions } = readOtherTabs(wb);
  const progress = (step: Step): Progress => (done, total) => onStep(step, done, total);
  const result: ReportFileResult = { saved: [], notes: [], needsRebuild: false };

  if (!mappingComplete(mapping)) result.notes.push(`The ${sheet.name} columns couldn't be matched; import this report on its own to map them.`);
  else if (!shipments.length) result.notes.push(`No PO lines in ${sheet.name}.`);
  else {
    onStep('po');
    result.needsRebuild = (await savePoLines({ fileName, sheetName: sheet.name, reportDate, mappingId: saved?.id ?? null, shipments }, progress('po'))).needsRebuild;
    result.saved.push(`${shipments.length.toLocaleString()} PO lines`);
    const errors = rows.filter((r) => r.errors.length).length;
    if (errors) result.notes.push(`${errors.toLocaleString()} PO rows with errors were left out.`);
  }
  if (odm.parsed?.orders.length) {
    await saveOdmOrders(odm.parsed, fileName, reportDate, progress('outbound'));
    result.saved.push(`${odm.parsed.orders.length.toLocaleString()} sales orders`);
  }
  if (inventory.parsed?.positions.length) {
    await saveInventory(inventory.parsed, fileName, reportDate, progress('inventory'));
    result.saved.push(`${inventory.parsed.receipts.length.toLocaleString()} received lots`);
  }
  if (transactions.parsed?.rows.length) {
    await saveShipped(transactions.parsed, reportDate, progress('shipped'));
    result.saved.push(`${transactions.parsed.rows.length.toLocaleString()} shipped lines`);
  }
  for (const tab of [odm, inventory, transactions]) if (tab.error) result.notes.push(tab.error);
  return result;
}
