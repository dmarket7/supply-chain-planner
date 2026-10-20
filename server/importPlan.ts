import { addDays } from '../shared/dates';
import type { ArrivalSource, LineChangeKind, PoStatus, ShipmentInput, ShipmentStatus } from '../shared/types';

export interface ExistingShipment {
  id: number;
  dedupeKey: string;
  poStatus: PoStatus | null;
  status: ShipmentStatus;
  promisedArrivalDate: string | null;
  actualArrivalDate: string | null;
  arrivalSource: ArrivalSource | null;
  arrivalWindowStart: string | null;
  arrivalWindowEnd: string | null;
  lastSeenOpenReportDate: string | null;
  lastTrackedAt: Date | string | null;
  shipDate?: string | null;
  trackingNumber?: string | null;
}

export interface IncomingRow extends ShipmentInput {
  dedupeKey: string;
}

/** Values the import writes for one shipment, on top of the report's own columns. */
export interface PlannedRow extends IncomingRow {
  status: ShipmentStatus;
  promisedArrivalDate: string | null;
  actualArrivalDate: string | null;
  arrivalSource: ArrivalSource | null;
  arrivalWindowStart: string | null;
  arrivalWindowEnd: string | null;
  lastSeenOpenReportDate: string | null;
}

export interface ImportPlan {
  rows: PlannedRow[];
  insertCount: number;
  updateCount: number;
  newlyClosed: number;
  promisedDateChanges: { dedupeKey: string; previousDate: string; newDate: string }[];
  /** Progress log entries for this upload (see LINE_CHANGE_KINDS). */
  changes: PlannedChange[];
}

export interface PlannedChange {
  dedupeKey: string;
  kind: LineChangeKind;
  from: string | null;
  to: string | null;
}

/** PO + line, to match a newly shipped (ASN) line with the "awaiting shipment" line it came from. */
export function poLineKey(r: { poNumber?: string | null; lineRef?: string | null }): string | null {
  return r.poNumber ? `${r.poNumber}\u0000${r.lineRef ?? ''}` : null;
}

const CONFIRMED: readonly (ArrivalSource | null)[] = ['manual', 'tracking'];
/** Statuses only a tracking provider sets; a report saying "Open" shouldn't overwrite them. */
const TRACKING_ONLY: readonly ShipmentStatus[] = ['out_for_delivery', 'exception', 'unknown'];

function clamp(date: string, min: string, max: string) {
  return date < min ? min : date > max ? max : date;
}

/**
 * Works out the new state of one shipment from this report and what earlier reports said.
 *
 * Arrival date for a Closed line, best evidence first:
 *  1. tracking / manual (confirmed): never overwritten by a report
 *  2. report window: the line was Open in an earlier report and Closed in this one, so it arrived
 *     in (lastSeenOpen, reportDate]. Estimate = the ETA moved into that window.
 *  3. ETA: first seen already Closed, so there is no evidence beyond the supplier's date.
 */
export function planRow(row: IncomingRow, prev: ExistingShipment | undefined, reportDate: string): PlannedRow {
  const promisedArrivalDate = row.promisedArrivalDate ?? prev?.promisedArrivalDate ?? null;
  const confirmed = prev && CONFIRMED.includes(prev.arrivalSource) && prev.actualArrivalDate;
  const lastSeenOpenReportDate =
    row.poStatus === 'open'
      ? reportDate
      : (prev?.lastSeenOpenReportDate ?? null);

  const base = {
    ...row,
    promisedArrivalDate,
    lastSeenOpenReportDate,
    arrivalWindowStart: null as string | null,
    arrivalWindowEnd: null as string | null,
  };

  if (confirmed) {
    return {
      ...base,
      status: 'delivered',
      actualArrivalDate: prev.actualArrivalDate,
      arrivalSource: prev.arrivalSource,
      arrivalWindowStart: prev.arrivalWindowStart,
      arrivalWindowEnd: prev.arrivalWindowEnd,
    };
  }

  if (row.actualArrivalDate) {
    return { ...base, status: 'delivered', actualArrivalDate: row.actualArrivalDate, arrivalSource: 'import' };
  }

  if (row.poStatus === 'closed') {
    // Already dated by an earlier report: keep that estimate rather than re-deriving it.
    if (prev?.poStatus === 'closed' && prev.actualArrivalDate) {
      return {
        ...base,
        status: 'delivered',
        actualArrivalDate: prev.actualArrivalDate,
        arrivalSource: prev.arrivalSource,
        arrivalWindowStart: prev.arrivalWindowStart,
        arrivalWindowEnd: prev.arrivalWindowEnd,
      };
    }
    if (prev?.lastSeenOpenReportDate && prev.lastSeenOpenReportDate < reportDate) {
      const start = addDays(prev.lastSeenOpenReportDate, 1);
      return {
        ...base,
        status: 'delivered',
        actualArrivalDate: promisedArrivalDate ? clamp(promisedArrivalDate, start, reportDate) : reportDate,
        arrivalSource: 'report_window',
        arrivalWindowStart: start,
        arrivalWindowEnd: reportDate,
      };
    }
    return {
      ...base,
      status: 'delivered',
      actualArrivalDate: promisedArrivalDate,
      arrivalSource: promisedArrivalDate ? 'eta' : null,
    };
  }

  // Open (or a report without PO status): not arrived yet.
  let status: ShipmentStatus;
  if (prev?.lastTrackedAt && TRACKING_ONLY.includes(prev.status)) status = prev.status;
  else if (row.asn || row.trackingNumber) status = 'in_transit';
  else if (promisedArrivalDate) status = 'pending';
  else status = 'awaiting_shipment';
  return { ...base, status, actualArrivalDate: null, arrivalSource: null };
}

/**
 * @param awaitingPoLines poLineKey()s of PO lines that earlier reports listed as awaiting shipment; a new
 *   ASN line for one of them is logged as "shipped" rather than "new".
 */
export function planImport(
  rows: IncomingRow[],
  existing: ExistingShipment[],
  reportDate: string,
  awaitingPoLines: ReadonlySet<string> = new Set(),
): ImportPlan {
  const existingByKey = new Map(existing.map((e) => [e.dedupeKey, e]));
  const planned: PlannedRow[] = [];
  const promisedDateChanges: ImportPlan['promisedDateChanges'] = [];
  let updateCount = 0;
  let newlyClosed = 0;
  const changes: PlannedChange[] = [];

  for (const row of rows) {
    const prev = existingByKey.get(row.dedupeKey);
    const next = planRow(row, prev, reportDate);
    planned.push(next);
    const log = (kind: LineChangeKind, from: string | null, to: string | null) =>
      changes.push({ dedupeKey: row.dedupeKey, kind, from, to });
    if (!prev) {
      const key = poLineKey(row);
      if (row.asn && key && awaitingPoLines.has(key)) {
        log('shipped', null, row.asn);
        // Shipped and received between two reports.
        if (row.poStatus === 'closed') log('closed', null, next.actualArrivalDate);
      } else log('new', null, next.status);
      continue;
    }
    updateCount++;
    if (prev.poStatus === 'open' && row.poStatus === 'closed') {
      newlyClosed++;
      log('closed', null, next.actualArrivalDate);
    }
    if (prev.poStatus === 'closed' && row.poStatus === 'open') log('reopened', null, null);
    if (next.promisedArrivalDate && prev.promisedArrivalDate !== next.promisedArrivalDate) {
      log('eta_changed', prev.promisedArrivalDate, next.promisedArrivalDate);
    }
    if (prev.shipDate !== undefined && row.shipDate && prev.shipDate !== row.shipDate) log('ship_date_changed', prev.shipDate, row.shipDate);
    if (prev.trackingNumber !== undefined && row.trackingNumber && prev.trackingNumber !== row.trackingNumber) {
      log(prev.trackingNumber ? 'tracking_changed' : 'tracking_added', prev.trackingNumber, row.trackingNumber);
    }
    if (prev.promisedArrivalDate && next.promisedArrivalDate && prev.promisedArrivalDate !== next.promisedArrivalDate) {
      promisedDateChanges.push({
        dedupeKey: row.dedupeKey,
        previousDate: prev.promisedArrivalDate,
        newDate: next.promisedArrivalDate,
      });
    }
  }
  return { rows: planned, insertCount: planned.length - updateCount, updateCount, newlyClosed, promisedDateChanges, changes };
}
