import * as XLSX from 'xlsx';
import { getTracking } from 'ts-tracking-number';
import { addDays } from '../../../shared/dates';
import type { ColumnMapping, PoStatus, ShipmentInput, ShipmentMode } from '../../../shared/types';
import type { Cell } from './parseWorkbook';

export interface NormalizeOptions {
  /** YYYY-MM-DD the report was run. */
  reportDate: string;
  /** Closed lines are imported only when their ETA is within this many days before the report date. */
  closedWindowDays: number;
}

export interface NormalizedRow {
  /** 1-based spreadsheet row number, for showing errors to the user. */
  rowNumber: number;
  shipment: ShipmentInput | null;
  /** Set when a valid row is intentionally left out (e.g. a line that closed long ago). */
  skipped: string | null;
  errors: string[];
  warnings: string[];
}

const NAMED_CARRIERS: [RegExp, string, ShipmentMode][] = [
  [/^(ups|united parcel)/i, 'UPS', 'parcel'],
  [/^(fedex|fed ex|federal express)/i, 'FedEx', 'parcel'],
  [/^(usps|us postal|u\.s\. postal|united states postal|postal service)/i, 'USPS', 'parcel'],
  [/^dhl/i, 'DHL', 'parcel'],
  [/^ontrac/i, 'OnTrac', 'parcel'],
  [/^amazon/i, 'Amazon', 'parcel'],
  [/^dsv/i, 'DSV', 'freight'],
  [/^(k\s*&\s*n|k\+n|kuehne)/i, 'Kuehne+Nagel', 'freight'],
];

/** IATA airline prefixes seen on air waybills ("297-73979334"). Unknown prefixes show as "Air cargo". */
const AIRLINE_PREFIXES: Record<string, string> = {
  '001': 'American Airlines Cargo',
  '006': 'Delta Cargo',
  '016': 'United Cargo',
  '020': 'Lufthansa Cargo',
  '023': 'FedEx (air)',
  '057': 'Air France Cargo',
  '074': 'KLM Cargo',
  '112': 'China Cargo Airlines',
  '160': 'Cathay Cargo',
  '172': 'Cargolux',
  '176': 'Emirates SkyCargo',
  '180': 'Korean Air Cargo',
  '297': 'China Airlines Cargo',
  '369': 'Atlas Air',
  '406': 'UPS (air)',
  '618': 'Singapore Airlines Cargo',
  '695': 'EVA Air Cargo',
  '784': 'China Southern Cargo',
  '988': 'Asiana Cargo',
  '999': 'Air China Cargo',
};

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

/** Report date from a file name like "… Report 20261010.xlsx", or null. */
export function reportDateFromFileName(name: string): string | null {
  const m = name.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/);
  return m ? iso(+m[1], +m[2], +m[3]) : null;
}

function text(value: Cell): string | null {
  if (value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

export function normalizePoStatus(value: Cell): PoStatus | null {
  const s = text(value)?.toLowerCase();
  if (!s) return null;
  if (s.startsWith('open')) return 'open';
  if (s.startsWith('clos') || s === 'received' || s === 'complete' || s === 'completed') return 'closed';
  return null;
}

export interface ParsedTracking {
  trackingNumber: string | null;
  trackingRef: string | null;
  /** A carrier/mode word typed where a tracking number belongs, e.g. "Truck". */
  placeholder: string | null;
}

/**
 * Splits a tracking cell into the number to track and any secondary reference:
 * "HKG19921086/IS20260944701" -> HKG19921086 + ref IS20260944701; "Truck" -> placeholder.
 */
export function parseTrackingCell(value: Cell): ParsedTracking {
  const s = text(value);
  if (!s) return { trackingNumber: null, trackingRef: null, placeholder: null };
  if (!/\d/.test(s)) return { trackingNumber: null, trackingRef: null, placeholder: s };

  const parts = s
    .split(/[/,;|\n\r]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(cleanTrackingNumber);
  const [first, ...rest] = parts;
  return { trackingNumber: first ?? null, trackingRef: rest.length ? rest.join(' / ') : null, placeholder: null };
}

function cleanTrackingNumber(raw: string): string {
  const upper = raw.toUpperCase().replace(/\s+/g, ' ');
  const awb = upper.match(/^(\d{3})[\s-]?(\d{8})$/);
  if (awb) return `${awb[1]}-${awb[2]}`;
  return upper.replace(/[\s-]+/g, '');
}

export interface CarrierGuess {
  carrier: string | null;
  mode: ShipmentMode | null;
  /** False when the guess is based on length/shape only (no check digit). */
  confident: boolean;
}

export function normalizeCarrier(name: string | null): CarrierGuess {
  if (!name) return { carrier: null, mode: null, confident: false };
  for (const [re, canonical, mode] of NAMED_CARRIERS) {
    if (re.test(name.trim())) return { carrier: canonical, mode, confident: true };
  }
  // Any other named carrier is assumed to be a freight carrier or forwarder.
  return { carrier: name.trim(), mode: 'freight', confident: true };
}

/** Carrier inferred from a tracking number's format. */
export function detectCarrier(trackingNumber: string): CarrierGuess {
  const byCode: Record<string, string> = { ups: 'UPS', fedex: 'FedEx', usps: 'USPS', dhl: 'DHL', ontrac: 'OnTrac', amazon: 'Amazon' };
  const code = getTracking(trackingNumber)?.courier.code;
  if (code && byCode[code]) return { carrier: byCode[code], mode: 'parcel', confident: true };

  const awb = trackingNumber.match(/^(\d{3})-\d{8}$/);
  if (awb) return { carrier: AIRLINE_PREFIXES[awb[1]] ?? 'Air cargo', mode: 'freight', confident: !!AIRLINE_PREFIXES[awb[1]] };
  if (/^\d{12}$/.test(trackingNumber)) return { carrier: 'FedEx', mode: 'parcel', confident: false };
  if (/^\d{10}$/.test(trackingNumber)) return { carrier: 'DHL', mode: 'parcel', confident: false };
  // House bills from forwarders usually start with an origin airport code: HKG…, LAX…, TPE…
  if (/^[A-Z]{3}\d{6,}$/.test(trackingNumber)) return { carrier: 'Forwarder', mode: 'freight', confident: false };
  return { carrier: null, mode: null, confident: false };
}

export function normalizeRow(
  raw: Record<string, Cell>,
  mapping: ColumnMapping,
  rowNumber: number,
  options: NormalizeOptions,
): NormalizedRow {
  const get = (f: keyof ColumnMapping) => (mapping[f] ? (raw[mapping[f]!] ?? null) : null);
  const errors: string[] = [];
  const warnings: string[] = [];
  const result = (shipment: ShipmentInput | null, skipped: string | null = null): NormalizedRow => ({
    rowNumber,
    shipment,
    skipped,
    errors,
    warnings,
  });

  const supplier = text(get('supplier'));
  if (!supplier) errors.push('Missing supplier');

  const poStatus = normalizePoStatus(get('poStatus'));
  if (mapping.poStatus && text(get('poStatus')) && !poStatus) warnings.push(`Unrecognized PO status "${get('poStatus')}"`);

  const dateField = (f: 'promisedArrivalDate' | 'shipDate' | 'requestDate' | 'actualArrivalDate', label: string) => {
    const v = get(f);
    const d = toIsoDate(v);
    if (v !== null && text(v) && !d) warnings.push(`Ignored unreadable ${label} "${v}"`);
    return d;
  };
  let promisedArrivalDate = dateField('promisedArrivalDate', 'ETA');
  const shipDate = dateField('shipDate', 'ship date');
  const requestDate = dateField('requestDate', 'request date');
  const actualArrivalDate = dateField('actualArrivalDate', 'arrival date');

  if (promisedArrivalDate && promisedArrivalDate < addDays(options.reportDate, -3 * 365)) {
    warnings.push(`Ignored ETA ${promisedArrivalDate}: more than 3 years before the report`);
    promisedArrivalDate = null;
  }
  if (promisedArrivalDate && shipDate && promisedArrivalDate < shipDate) {
    warnings.push('ETA is before the ship date');
  }
  // Without a PO status column (generic reports) every row needs an ETA to place it on the calendar.
  if (!mapping.poStatus && !promisedArrivalDate) errors.push('Missing ETA / promised arrival date');

  const trackingCell = get('trackingNumber');
  if (typeof trackingCell === 'number' && trackingCell >= 1e15) {
    warnings.push('Tracking number is stored as a number in Excel and may have lost digits; format that column as Text');
  }
  const tracking = parseTrackingCell(trackingCell);
  const poNumber = text(get('poNumber'));
  if (!tracking.trackingNumber && !poNumber) errors.push('Needs a tracking number or a PO number');

  const qtyRaw = get('quantity');
  const quantity = qtyRaw === null || qtyRaw === '' ? null : Number(qtyRaw);
  if (quantity !== null && Number.isNaN(quantity)) warnings.push(`Ignored non-numeric quantity "${qtyRaw}"`);

  if (errors.length) return result(null);

  if (poStatus === 'closed') {
    if (!promisedArrivalDate) return result(null, 'Closed line without an ETA');
    if (promisedArrivalDate < addDays(options.reportDate, -options.closedWindowDays)) {
      return result(null, `Closed line with ETA more than ${options.closedWindowDays} days before the report`);
    }
  }

  let guess = normalizeCarrier(text(get('carrier')));
  if (!guess.carrier && tracking.placeholder) guess = normalizeCarrier(tracking.placeholder);
  if (tracking.trackingNumber) {
    const detected = detectCarrier(tracking.trackingNumber);
    if (!guess.carrier) guess = detected;
    else if (detected.confident && detected.carrier !== guess.carrier && guess.mode === 'parcel') {
      warnings.push(`${tracking.trackingNumber} looks like ${detected.carrier} but the report says ${guess.carrier}`);
    }
  }

  return result({
    supplier: supplier!,
    poNumber,
    lineRef: text(get('lineRef')),
    asn: text(get('asn')),
    poStatus,
    customerPo: text(get('customerPo')),
    partNumber: text(get('partNumber')),
    itemDescription: text(get('itemDescription')),
    commodity: text(get('commodity')),
    warehouse: text(get('warehouse')),
    quantity: quantity !== null && !Number.isNaN(quantity) ? quantity : null,
    carrier: guess.carrier,
    mode: guess.mode,
    trackingNumber: tracking.trackingNumber,
    trackingRef: tracking.trackingRef,
    requestDate,
    shipDate,
    promisedArrivalDate,
    actualArrivalDate,
    sourceRow: raw,
  });
}
