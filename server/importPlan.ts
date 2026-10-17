import type { ShipmentInput } from '../shared/types';

export interface ExistingShipment {
  id: number;
  dedupeKey: string;
  promisedArrivalDate: string;
}

export interface PlannedRow extends ShipmentInput {
  dedupeKey: string;
  supplierId: number;
}

export interface ImportPlan {
  rows: PlannedRow[];
  insertCount: number;
  updateCount: number;
  promisedDateChanges: { dedupeKey: string; previousDate: string; newDate: string }[];
}

export function dedupeKey(row: ShipmentInput, supplierId: number): string {
  if (row.trackingNumber) return `trk:${row.trackingNumber.toUpperCase().replace(/\s+/g, '')}`;
  return `po:${supplierId}:${(row.poNumber ?? '').trim().toUpperCase()}:${(row.lineRef ?? '').trim().toUpperCase()}`;
}

/**
 * Works out what an import will do: collapses duplicate rows within the file (last one wins),
 * splits inserts from updates, and finds promised-date changes on existing shipments.
 */
export function planImport(
  input: ShipmentInput[],
  supplierIds: Map<string, number>,
  existing: ExistingShipment[],
): ImportPlan {
  const byKey = new Map<string, PlannedRow>();
  for (const row of input) {
    const supplierId = supplierIds.get(row.supplier);
    if (supplierId === undefined) throw new Error(`Unknown supplier: ${row.supplier}`);
    const key = dedupeKey(row, supplierId);
    byKey.set(key, { ...row, dedupeKey: key, supplierId });
  }

  const existingByKey = new Map(existing.map((e) => [e.dedupeKey, e]));
  const rows = [...byKey.values()];
  const promisedDateChanges: ImportPlan['promisedDateChanges'] = [];
  let updateCount = 0;
  for (const row of rows) {
    const prev = existingByKey.get(row.dedupeKey);
    if (!prev) continue;
    updateCount++;
    if (prev.promisedArrivalDate !== row.promisedArrivalDate) {
      promisedDateChanges.push({
        dedupeKey: row.dedupeKey,
        previousDate: prev.promisedArrivalDate,
        newDate: row.promisedArrivalDate,
      });
    }
  }
  return { rows, insertCount: rows.length - updateCount, updateCount, promisedDateChanges };
}
