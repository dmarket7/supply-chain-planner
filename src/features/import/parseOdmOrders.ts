import type * as XLSX from 'xlsx';
import type { OutboundOrderInput } from '../../../shared/types';
import { toIsoDate } from './normalize';
import { parseSheet, type Cell } from './parseWorkbook';
import { findSheet, norm, number, text } from './sheetColumns';

/** Columns of the ODM Open Order tab, matched by header (case and punctuation ignored). */
const COLUMNS = {
  soNumber: 'wintecso',
  shipTo: 'shipto',
  cpn: 'cpn',
  quantity: 'quantity',
  emsPo: 'emspo',
  status: 'statusissue',
  salesType: 'salestype',
  warehouse: 'warehouse',
  mpn: 'mpn',
  manufacturer: 'manufacturer',
  businessGroup: 'businessgroup',
  packagingType: 'packagingtype',
  totalPrice: 'totalprice',
  scheduledShipDate: 'systemscheduleshipdate',
  confirmedShipDate: 'wintecconfirmedshipdate',
  dockDate: 'emsrequesteddockdate',
  // The report spells it "Origianl Requested Date".
  originalRequestDate: ['origianlrequesteddate', 'originalrequesteddate'],
  poReceiptDate: 'poreceiptdate',
} as const;
type Column = keyof typeof COLUMNS;
const REQUIRED = ['soNumber', 'shipTo', 'cpn', 'quantity'] as const satisfies Column[];
/** Ship dates this far out are placeholders for "not scheduled yet" (the report uses 2099). */
const PLACEHOLDER_YEAR = 2090;

/** A real ship date, or null for blanks and 2099-style placeholders. */
function shipDate(v: Cell): string | null {
  const d = toIsoDate(v);
  return d && Number(d.slice(0, 4)) < PLACEHOLDER_YEAR ? d : null;
}

/** The ODM Open Order tab: by name first, else any sheet with the required columns. */
export function findOdmSheet(wb: XLSX.WorkBook): string | null {
  return findSheet(wb, REQUIRED.map((c) => COLUMNS[c]), /odm/i);
}

export interface ParsedOdmOrders {
  sheetName: string;
  rowCount: number;
  orders: OutboundOrderInput[];
  skippedQuotations: number;
  unscheduledOrders: number;
  errors: string[];
}

/**
 * Reads open sales orders. The report splits one order into reservation pieces, often identical
 * rows, so pieces are summed (never de-duplicated) into one order per SO, status, part, ship-to and
 * ship date. Quotations are left out.
 */
export function parseOdmOrders(wb: XLSX.WorkBook, sheetName: string): ParsedOdmOrders {
  const sheet = parseSheet(wb, sheetName);
  const header = new Map(sheet.headers.map((h) => [norm(h), h]));
  const columnHeader = Object.fromEntries(
    (Object.keys(COLUMNS) as Column[]).map((c) => [c, ([COLUMNS[c]].flat() as string[]).map((n) => header.get(n)).find(Boolean)]),
  ) as Record<Column, string | undefined>;
  const missing = REQUIRED.filter((c) => !columnHeader[c]);
  if (missing.length) {
    throw new Error(`"${sheetName}" is missing column${missing.length > 1 ? 's' : ''}: ${missing.map((c) => COLUMNS[c]).join(', ')}`);
  }
  const get = (row: Record<string, Cell>, c: Column): Cell => {
    const h = columnHeader[c];
    return h ? (row[h] ?? null) : null;
  };

  const orders = new Map<string, OutboundOrderInput>();
  const errors: string[] = [];
  let skippedQuotations = 0;
  sheet.rows.forEach((r, i) => {
    const rowNumber = sheet.headerRowIndex + i + 2;
    if (/quotation/i.test(text(get(r, 'salesType')) ?? '')) {
      skippedQuotations++;
      return;
    }
    const soNumber = text(get(r, 'soNumber'));
    const quantity = number(get(r, 'quantity'));
    if (!soNumber || quantity === null || quantity < 0) {
      errors.push(`Row ${rowNumber}: ${soNumber ? 'quantity is not a number' : 'no Wintec SO#'}`);
      return;
    }
    const confirmed = shipDate(get(r, 'confirmedShipDate'));
    const scheduled = shipDate(get(r, 'scheduledShipDate'));
    const order: OutboundOrderInput = {
      soNumber,
      emsPo: text(get(r, 'emsPo')),
      status: text(get(r, 'status')),
      warehouse: text(get(r, 'warehouse')),
      shipTo: text(get(r, 'shipTo')),
      cpn: text(get(r, 'cpn')),
      mpn: text(get(r, 'mpn')),
      manufacturer: text(get(r, 'manufacturer')),
      businessGroup: text(get(r, 'businessGroup')),
      packagingType: text(get(r, 'packagingType')),
      quantity,
      totalPrice: number(get(r, 'totalPrice')),
      sourceRows: 1,
      shipDate: confirmed ?? scheduled,
      shipDateSource: confirmed ? 'confirmed' : scheduled ? 'scheduled' : null,
      scheduledShipDate: scheduled,
      confirmedShipDate: confirmed,
      dockDate: toIsoDate(get(r, 'dockDate')),
      originalRequestDate: toIsoDate(get(r, 'originalRequestDate')),
      poReceiptDate: toIsoDate(get(r, 'poReceiptDate')),
    };
    const key = [order.soNumber, order.status, order.cpn, order.mpn, order.shipTo, order.shipDate].join('\u0000');
    const prev = orders.get(key);
    if (!prev) {
      orders.set(key, order);
      return;
    }
    prev.quantity += order.quantity;
    prev.totalPrice = prev.totalPrice === null && order.totalPrice === null ? null : (prev.totalPrice ?? 0) + (order.totalPrice ?? 0);
    prev.sourceRows++;
    for (const k of ['emsPo', 'warehouse', 'manufacturer', 'businessGroup', 'packagingType', 'dockDate', 'originalRequestDate', 'poReceiptDate'] as const) prev[k] ??= order[k];
  });

  const list = [...orders.values()];
  return {
    sheetName,
    rowCount: sheet.rows.length,
    orders: list,
    skippedQuotations,
    unscheduledOrders: list.filter((o) => !o.shipDate).length,
    errors,
  };
}
