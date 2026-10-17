import { arrivalVariance } from '../shared/dates';
import type { ArrivalLogEntry, InboundDay, Shipment, SupplierScore } from '../shared/types';

export function expectedArrival(s: Pick<Shipment, 'estimatedArrivalDate' | 'promisedArrivalDate'>) {
  return s.estimatedArrivalDate ?? s.promisedArrivalDate;
}

/** Groups shipments by expected arrival day (tracking ETA if known, else promised date). */
export function groupInboundByDay(shipments: Shipment[]): InboundDay[] {
  const days = new Map<string, InboundDay>();
  for (const s of shipments) {
    const date = expectedArrival(s);
    let day = days.get(date);
    if (!day) {
      day = { date, total: 0, byCarrier: {}, byStatus: {}, shipments: [] };
      days.set(date, day);
    }
    const carrier = s.carrier ?? 'Unknown';
    day.total++;
    day.byCarrier[carrier] = (day.byCarrier[carrier] ?? 0) + 1;
    day.byStatus[s.status] = (day.byStatus[s.status] ?? 0) + 1;
    day.shipments.push(s);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function toArrivalEntry(s: Shipment & { originalPromisedDate: string }): ArrivalLogEntry {
  return { ...s, ...arrivalVariance(s.originalPromisedDate, s.actualArrivalDate!) };
}

export function supplierScorecard(entries: ArrivalLogEntry[]): SupplierScore[] {
  const bySupplier = new Map<string, ArrivalLogEntry[]>();
  for (const e of entries) {
    const list = bySupplier.get(e.supplier) ?? [];
    list.push(e);
    bySupplier.set(e.supplier, list);
  }
  return [...bySupplier.entries()]
    .map(([supplier, list]) => {
      const onTime = list.filter((e) => e.onTime).length;
      const totalVariance = list.reduce((sum, e) => sum + e.varianceDays, 0);
      return {
        supplier,
        arrivals: list.length,
        onTime,
        onTimePct: Math.round((onTime / list.length) * 1000) / 10,
        avgVarianceDays: Math.round((totalVariance / list.length) * 10) / 10,
      };
    })
    .sort((a, b) => a.onTimePct - b.onTimePct || b.arrivals - a.arrivals);
}
