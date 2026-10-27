import { arrivalVariance } from '../shared/dates';
import { addLine, emptySummary, type RatioLookup } from '../shared/pallets';
import type { ArrivalLogEntry, InboundDay, InboundPart, InboundShipment, Shipment, SupplierScore } from '../shared/types';

export function expectedArrival(s: Pick<Shipment, 'estimatedArrivalDate' | 'promisedArrivalDate'>) {
  return s.estimatedArrivalDate ?? s.promisedArrivalDate;
}

/** Adds each line's pallet conversion. */
export function withPallets(shipments: Shipment[], ratios: RatioLookup): InboundShipment[] {
  return shipments.map((s) => ({ ...s, pallets: ratios.line(s.partNumber, s.commodity, s.quantity) }));
}

/**
 * Groups shipments by expected arrival day (tracking ETA if known, else the supplier's ETA).
 * Lines with neither (awaiting shipment) have no day and are left out.
 */
export function groupInboundByDay(shipments: InboundShipment[]): InboundDay[] {
  const days = new Map<string, InboundDay>();
  for (const s of shipments) {
    const date = expectedArrival(s);
    if (!date) continue;
    let day = days.get(date);
    if (!day) {
      day = { date, total: 0, byCarrier: {}, byStatus: {}, pallets: emptySummary(), shipments: [] };
      days.set(date, day);
    }
    const carrier = s.carrier ?? 'Unknown';
    day.total++;
    day.byCarrier[carrier] = (day.byCarrier[carrier] ?? 0) + 1;
    day.byStatus[s.status] = (day.byStatus[s.status] ?? 0) + 1;
    addLine(day.pallets, s.pallets, s.quantity);
    day.shipments.push(s);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Inbound by part, most pallets first; parts with no ratio last, by units. */
export function groupInboundByPart(shipments: InboundShipment[]): InboundPart[] {
  const parts = new Map<string, InboundPart>();
  for (const s of shipments) {
    const key = s.partNumber ?? '';
    let part = parts.get(key);
    if (!part) {
      const { basis, unitsPerPallet, estimate } = s.pallets;
      part = { partNumber: s.partNumber, description: s.itemDescription, commodity: s.commodity, basis, unitsPerPallet, estimate, pallets: emptySummary() };
      parts.set(key, part);
    }
    part.description ??= s.itemDescription;
    part.commodity ??= s.commodity;
    addLine(part.pallets, s.pallets, s.quantity);
  }
  return [...parts.values()].sort(
    (a, b) =>
      Number(a.basis === 'none') - Number(b.basis === 'none') ||
      b.pallets.palletEq - a.pallets.palletEq ||
      b.pallets.units - a.pallets.units,
  );
}

export function toArrivalEntry(s: Shipment & { originalPromisedDate: string }): ArrivalLogEntry {
  return { ...s, ...arrivalVariance(s.originalPromisedDate, s.actualArrivalDate!) };
}

/**
 * Per-supplier on-time stats. Arrivals dated only from the supplier's own ETA (`eta` source)
 * say nothing about whether the supplier kept its promise, so they're left out unless asked for.
 */
export function supplierScorecard(entries: ArrivalLogEntry[], includeAssumed = false): SupplierScore[] {
  const bySupplier = new Map<string, ArrivalLogEntry[]>();
  for (const e of entries) {
    if (!includeAssumed && e.arrivalSource === 'eta') continue;
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
