import * as XLSX from 'xlsx';
import { getTracking } from 'ts-tracking-number';
import type { ColumnMapping, ShipmentInput, ShipmentMode } from '../../../shared/types';
import type { Cell } from './parseWorkbook';

export interface NormalizedRow {
  /** 1-based spreadsheet row number, for showing errors to the user. */
  rowNumber: number;
  /** One shipment per tracking number in the row (empty when the row has errors). */
  shipments: ShipmentInput[];
  errors: string[];
  warnings: string[];
}

const PARCEL_CARRIERS: [RegExp, string][] = [
  [/^(ups|united parcel)/i, 'UPS'],
  [/^(fedex|fed ex|federal express)/i, 'FedEx'],
  [/^(usps|us postal|u\.s\. postal|united states postal|postal service)/i, 'USPS'],
  [/^dhl/i, 'DHL'],
  [/^ontrac/i, 'OnTrac'],
  [/^amazon/i, 'Amazon'],
];
const PARCEL_NAMES = new Set(PARCEL_CARRIERS.map(([, n]) => n));

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Excel serial numbers and common US date strings -> YYYY-MM-DD. Returns null if unparseable. */
export function toIsoDate(value: Cell): string | null {
  if (value === null || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    const p = XLSX.SSF.parse_date_code(value);
    return p ? iso(p.y, p.m, p.d) : null;
  }
  const s = value.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) return iso(+m[3], +m[1], +m[2]); // M/D/Y
  if ((m = s.match(/^(\d{1,2})[-\s]([a-z]{3})[a-z]*[-\s,]+(\d{2,4})$/i))) {
    const mon = MONTHS.indexOf(m[2].toLowerCase());
    return mon >= 0 ? iso(+m[3], mon + 1, +m[1]) : null; // 17-Oct-2026
  }
  if ((m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i))) {
    const mon = MONTHS.indexOf(m[1].toLowerCase());
    return mon >= 0 ? iso(+m[3], mon + 1, +m[2]) : null; // Oct 17, 2026
  }
  return null;
}

function text(value: Cell): string | null {
  if (value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** Splits a cell that may hold several tracking numbers ("1Z..., 1Z..." or one per line). */
export function splitTrackingNumbers(value: Cell): string[] {
  const s = text(value);
  if (!s) return [];
  return s
    .split(/[,;|\n\r]+/)
    .map((t) => t.replace(/[\s-]+/g, '').toUpperCase())
    .filter(Boolean);
}

export function normalizeCarrier(name: string | null): { carrier: string | null; mode: ShipmentMode | null } {
  if (!name) return { carrier: null, mode: null };
  for (const [re, canonical] of PARCEL_CARRIERS) {
    if (re.test(name.trim())) return { carrier: canonical, mode: 'parcel' };
  }
  // Anything else named in the report is assumed to be a freight/LTL carrier.
  return { carrier: name.trim(), mode: 'ltl' };
}

/** Parcel carrier inferred from the tracking number's format and check digit. */
export function detectCarrier(trackingNumber: string): string | null {
  const code = getTracking(trackingNumber)?.courier.code;
  const byCode: Record<string, string> = { ups: 'UPS', fedex: 'FedEx', usps: 'USPS', dhl: 'DHL', ontrac: 'OnTrac', amazon: 'Amazon' };
  return code ? (byCode[code] ?? null) : null;
}

export function normalizeRow(raw: Record<string, Cell>, mapping: ColumnMapping, rowNumber: number): NormalizedRow {
  const get = (f: keyof ColumnMapping) => (mapping[f] ? (raw[mapping[f]!] ?? null) : null);
  const errors: string[] = [];
  const warnings: string[] = [];

  const supplier = text(get('supplier'));
  if (!supplier) errors.push('Missing supplier');

  const promisedRaw = get('promisedArrivalDate');
  const promisedArrivalDate = toIsoDate(promisedRaw);
  if (!promisedArrivalDate) {
    errors.push(promisedRaw === null ? 'Missing promised arrival date' : `Unreadable promised date "${promisedRaw}"`);
  }

  const dateField = (f: 'shipDate' | 'actualArrivalDate', label: string) => {
    const v = get(f);
    const d = toIsoDate(v);
    if (v !== null && text(v) && !d) warnings.push(`Ignored unreadable ${label} "${v}"`);
    return d;
  };
  const shipDate = dateField('shipDate', 'ship date');
  const actualArrivalDate = dateField('actualArrivalDate', 'arrival date');

  const trackingCell = get('trackingNumber');
  if (typeof trackingCell === 'number' && trackingCell >= 1e15) {
    warnings.push('Tracking number is stored as a number in Excel and may have lost digits; format that column as Text');
  }
  const trackingNumbers = splitTrackingNumbers(trackingCell);
  const poNumber = text(get('poNumber'));
  if (!trackingNumbers.length && !poNumber) errors.push('Needs a tracking number or a PO number');

  const qtyRaw = get('quantity');
  const quantity = qtyRaw === null || qtyRaw === '' ? null : Number(qtyRaw);
  if (quantity !== null && Number.isNaN(quantity)) warnings.push(`Ignored non-numeric quantity "${qtyRaw}"`);

  if (errors.length) return { rowNumber, shipments: [], errors, warnings };

  const listed = normalizeCarrier(text(get('carrier')));
  const base = {
    supplier: supplier!,
    poNumber,
    lineRef: text(get('lineRef')),
    itemDescription: text(get('itemDescription')),
    quantity: quantity !== null && !Number.isNaN(quantity) ? quantity : null,
    shipDate,
    promisedArrivalDate: promisedArrivalDate!,
    actualArrivalDate,
  };

  const shipments: ShipmentInput[] = (trackingNumbers.length ? trackingNumbers : [null]).map((tn) => {
    let { carrier, mode } = listed;
    if (tn) {
      const detected = detectCarrier(tn);
      if (!carrier && detected) {
        carrier = detected;
        mode = 'parcel';
      } else if (carrier && detected && PARCEL_NAMES.has(carrier) && detected !== carrier) {
        warnings.push(`${tn} looks like ${detected} but the report says ${carrier}`);
      }
    }
    return { ...base, trackingNumber: tn, carrier, mode };
  });
  if (trackingNumbers.length > 1) warnings.push(`Split into ${trackingNumbers.length} shipments (one per tracking number)`);

  return { rowNumber, shipments, errors, warnings };
}
