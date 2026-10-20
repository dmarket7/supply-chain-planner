import { addDays } from '../../shared/dates';
import type { ArrivalSource, ShipmentStatus } from '../../shared/types';
import type { TrackingResult } from './provider';

export interface TrackedLine {
  id: number;
  status: ShipmentStatus;
  estimatedArrivalDate?: string | null;
  lastEventAt?: Date | string | null;
  shipDate: string | null;
  actualArrivalDate: string | null;
  arrivalSource: ArrivalSource | null;
}

export interface LineUpdate {
  status: ShipmentStatus;
  estimatedArrivalDate: string | null;
  actualArrivalDate: string | null;
  arrivalSource: ArrivalSource | null;
  /** True when the arrival changed to a tracking-confirmed date (window cleared). */
  confirmedArrival: boolean;
  /** Why a delivery date from the provider was ignored, if it was. */
  ignoredDelivery: string | null;
}

/** Carriers recycle numbers; a "delivery" well before the line shipped belongs to an older parcel. */
const RECYCLED_TOLERANCE_DAYS = 2;

/**
 * How one tracking result changes one PO line. Tracking replaces estimated arrivals
 * (report window / ETA-assumed) but never a date someone entered by hand.
 */
export function applyTrackingResult(line: TrackedLine, result: TrackingResult): LineUpdate {
  const manual = line.arrivalSource === 'manual' && !!line.actualArrivalDate;
  const deliveredOn = result.deliveredAt?.slice(0, 10) ?? null;
  let ignoredDelivery: string | null = null;
  let acceptDelivery = !!deliveredOn;
  if (deliveredOn && line.shipDate && deliveredOn < addDays(line.shipDate, -RECYCLED_TOLERANCE_DAYS)) {
    acceptDelivery = false;
    ignoredDelivery = `Tracking shows delivery on ${deliveredOn}, before this line shipped (${line.shipDate}); likely a reused tracking number`;
  }

  if (manual) {
    return {
      status: 'delivered',
      estimatedArrivalDate: result.estimatedArrivalDate ?? null,
      actualArrivalDate: line.actualArrivalDate,
      arrivalSource: 'manual',
      confirmedArrival: false,
      ignoredDelivery,
    };
  }
  if (acceptDelivery) {
    return {
      status: 'delivered',
      estimatedArrivalDate: result.estimatedArrivalDate ?? null,
      actualArrivalDate: deliveredOn,
      arrivalSource: 'tracking',
      confirmedArrival: true,
      ignoredDelivery,
    };
  }
  // Not delivered (or delivery rejected): update progress, keep any report-based estimate.
  const status =
    result.status && result.status !== 'delivered' ? result.status : line.actualArrivalDate ? 'delivered' : line.status;
  return {
    status,
    estimatedArrivalDate: result.estimatedArrivalDate ?? null,
    actualArrivalDate: line.actualArrivalDate,
    arrivalSource: line.arrivalSource,
    confirmedArrival: false,
    ignoredDelivery,
  };
}

/** Newest scan time in a result, or null. */
export function latestEventAt(result: TrackingResult): string | null {
  let max: string | null = null;
  for (const e of result.events) if (!max || e.occurredAt > max) max = e.occurredAt;
  return max;
}

/** Whether applying a lookup changes anything someone would see: status, dates, or new scans. */
export function lineChanged(line: TrackedLine, update: LineUpdate, newestEvent: string | null): boolean {
  const prevEvent = line.lastEventAt ? new Date(line.lastEventAt).getTime() : null;
  return (
    update.status !== line.status ||
    update.estimatedArrivalDate !== (line.estimatedArrivalDate ?? null) ||
    update.actualArrivalDate !== line.actualArrivalDate ||
    update.arrivalSource !== line.arrivalSource ||
    (newestEvent !== null && (prevEvent === null || new Date(newestEvent).getTime() > prevEvent))
  );
}
