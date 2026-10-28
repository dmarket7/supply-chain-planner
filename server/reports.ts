import { arrivalVariance } from '../shared/dates';
import { addLine, addTruckGroup, emptySummary, emptyTrucks, type RatioLookup, type TruckSummary } from '../shared/pallets';
import type {
  ArrivalLogEntry,
  InboundDay,
  InboundPart,
  InboundShipment,
  OutboundBacklog,
  OutboundDay,
  OutboundOrder,
  OutboundPart,
  OutboundShipTo,
  Shipment,
  SupplierScore,
} from '../shared/types';

export function expectedArrival(s: Pick<Shipment, 'estimatedArrivalDate' | 'promisedArrivalDate'>) {
  return s.estimatedArrivalDate ?? s.promisedArrivalDate;
}

/** Adds each line's pallet conversion. */
export function withPallets<T extends Pick<Shipment, 'partNumber' | 'commodity' | 'quantity'>>(shipments: T[], ratios: RatioLookup): (T & Pick<InboundShipment, 'pallets'>)[] {
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

export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

const NO_SHIP_TO = '(no ship-to)';
export const shipToOf = (o: OutboundOrder) => o.shipTo ?? NO_SHIP_TO;

/** Trucks for orders that share trucks per ship-to and day. */
function trucksFor(orders: OutboundOrder[]): TruckSummary {
  const sum = emptyTrucks();
  for (const group of groupBy(orders, (o) => `${shipToOf(o)}\u0000${o.shipDate ?? ''}`).values()) addTruckGroup(sum, group);
  return sum;
}

export function backlog(orders: OutboundOrder[]): OutboundBacklog {
  const pallets = emptySummary();
  const readiness: OutboundBacklog['readiness'] = {};
  for (const o of orders) {
    addLine(pallets, o.pallets, o.quantity);
    if (!o.supply) continue;
    const r = (readiness[o.supply.readiness] ??= { orders: 0, units: 0, palletEq: 0 });
    r.orders++;
    r.units += o.quantity;
    r.palletEq += o.pallets.palletEq ?? 0;
  }
  return { orders: orders.length, pallets, trucks: trucksFor(orders), readiness };
}

const earliest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);

function partsOf(orders: OutboundOrder[]): OutboundPart[] {
  return [...groupBy(orders, (o) => `${o.mpn ?? ''}\u0000${o.cpn ?? ''}`).values()]
    .map((list) => {
      const o = list[0];
      const part: OutboundPart = {
        mpn: o.mpn,
        cpn: o.cpn,
        itemName: o.itemName,
        businessGroup: o.businessGroup,
        basis: o.pallets.basis,
        unitsPerPallet: o.pallets.unitsPerPallet,
        estimate: o.pallets.estimate,
        orders: list.length,
        pallets: emptySummary(),
        unitsByStatus: {},
        nextShipDate: null,
      };
      for (const x of list) {
        addLine(part.pallets, x.pallets, x.quantity);
        const status = x.status ?? 'Unknown';
        part.unitsByStatus[status] = (part.unitsByStatus[status] ?? 0) + x.quantity;
        part.nextShipDate = earliest(part.nextShipDate, x.shipDate);
      }
      return part;
    })
    .sort((a, b) => Number(a.basis === 'none') - Number(b.basis === 'none') || b.pallets.palletEq - a.pallets.palletEq || b.pallets.units - a.pallets.units);
}

/**
 * Open sales orders by ship date and by ship-to. Orders to the same ship-to on the same day share
 * trucks. Overdue and unscheduled orders are summarised over the whole snapshot; overdue is measured
 * against the report date (`asOf`), since orders due after it may have shipped since.
 */
export function outboundReport(orders: OutboundOrder[], from: string, to: string, asOf: string) {
  const inRange = orders.filter((o) => o.shipDate && o.shipDate >= from && o.shipDate <= to);

  const days: OutboundDay[] = [...groupBy(inRange, (o) => o.shipDate!)]
    .map(([date, list]) => ({ date, ...backlog(list) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const shipTos: OutboundShipTo[] = [...groupBy(inRange, shipToOf)]
    .map(([shipTo, list]) => ({
      shipTo,
      ...backlog(list),
      nextShipDate: list.reduce<string | null>((d, o) => earliest(d, o.shipDate), null),
      parts: partsOf(list),
      lines: [...list].sort((a, b) => a.shipDate!.localeCompare(b.shipDate!) || a.soNumber.localeCompare(b.soNumber)),
    }))
    .sort((a, b) => b.pallets.palletEq - a.pallets.palletEq || b.pallets.units - a.pallets.units);

  return {
    days,
    shipTos,
    overdue: backlog(orders.filter((o) => o.shipDate && o.shipDate < asOf)),
    unscheduled: backlog(orders.filter((o) => !o.shipDate)),
  };
}
