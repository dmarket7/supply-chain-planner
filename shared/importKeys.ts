import type { ShipmentInput } from './types';

const clean = (s: string | null | undefined) => (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * The identity of a shipment across reports. A PO line can ship in several deliveries, and one
 * tracking number can cover several lines, so the unit is PO + line + ASN. Reports without PO
 * numbers fall back to the tracking number.
 */
export function baseDedupeKey(row: Pick<ShipmentInput, 'poNumber' | 'lineRef' | 'asn' | 'trackingNumber'>): string {
  if (row.poNumber) return `po:${clean(row.poNumber)}:${clean(row.lineRef)}:${clean(row.asn)}`;
  return `trk:${clean(row.trackingNumber).replace(/\s+/g, '')}`;
}

/**
 * Keys for every row in a file. A key that repeats within one file (e.g. one delivery split by
 * country of origin) gets "#2", "#3", … in row order so each row stays its own shipment.
 * Must run over the whole file before it is split into upload chunks.
 */
export function dedupeKeysForFile(rows: Pick<ShipmentInput, 'poNumber' | 'lineRef' | 'asn' | 'trackingNumber'>[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = baseDedupeKey(row);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}
