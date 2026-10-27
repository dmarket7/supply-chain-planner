import { addDays } from '../shared/dates';
import { addLine, emptySummary, mergeSummaries, type RatioLookup } from '../shared/pallets';
import { siteOf, type Readiness } from '../shared/supply';
import type {
  DashboardBucket,
  DashboardResponse,
  DashboardTop,
  InboundShipment,
  OutboundOrder,
  SupplyInboundRow,
  SupplyOrderRow,
  SupplyPartRow,
} from '../shared/types';
import { backlog, expectedArrival, groupBy, shipToOf, withPallets } from './reports';
import type { LoadedOrder, loadSupply } from './supply';

type Supply = Awaited<ReturnType<typeof loadSupply>>;

const WEEKS = 4;
/** Outbound shipping within this many days (or already due) counts as at risk when late or short. */
const AT_RISK_DAYS = 14;
const TOP = 5;

export function withSupply(supply: Supply, ratios: RatioLookup): OutboundOrder[] {
  return supply.orders.map((o) => ({
    ...o,
    pallets: ratios.line(o.cpn, o.businessGroup, o.quantity),
    supply: supply.check?.orders.get(o.id) ?? null,
  }));
}

export function orderRow(o: LoadedOrder & Pick<OutboundOrder, 'supply'>): SupplyOrderRow {
  return {
    id: o.id,
    soNumber: o.soNumber,
    shipTo: o.shipTo,
    cpn: o.cpn,
    mpn: o.mpn,
    status: o.status,
    quantity: o.quantity,
    shipDate: o.shipDate,
    readiness: o.supply?.readiness ?? null,
    coveredBy: o.supply?.coveredBy ?? null,
    supplierShipDate: o.supply?.supplierShipDate ?? null,
    shortUnits: o.supply?.shortUnits ?? 0,
  };
}

const partKey = (part: string | null, branch: string | null) => `${part ?? ''}\u0000${siteOf(branch)}`;

/** Parts from the supply check, each with the orders that need it and its inbound lines. */
export function supplyParts(supply: Supply): SupplyPartRow[] {
  if (!supply.check) return [];
  const check = supply.check;
  const orders = groupBy(supply.orders, (o) => partKey(o.cpn, o.warehouse));
  const inbound = groupBy(supply.inbound, (s) => partKey(s.partNumber, s.branch));
  const vendorPn = new Map(supply.positions.map((p) => [partKey(p.partNumber, p.branch), p.vendorPn]));
  return check.parts.map((p) => {
    const k = `${p.partNumber}\u0000${p.site}`;
    const list = orders.get(k) ?? [];
    return {
      ...p,
      mpn: list[0]?.mpn ?? vendorPn.get(k) ?? null,
      orderRows: list
        .map((o) => orderRow({ ...o, supply: check.orders.get(o.id) ?? null }))
        .sort((a, b) => (a.shipDate ?? '9999').localeCompare(b.shipDate ?? '9999')),
      inbound: (inbound.get(k) ?? [])
        .map(
          (s): SupplyInboundRow => ({
            id: s.id,
            supplier: s.supplier,
            poNumber: s.poNumber,
            lineRef: s.lineRef,
            branch: s.branch,
            quantity: s.quantity,
            eta: expectedArrival(s),
            status: s.status,
          }),
        )
        .sort((a, b) => (a.eta ?? '9999').localeCompare(b.eta ?? '9999')),
    };
  });
}

function top<T>(items: T[], name: (x: T) => string, units: (x: T) => number, palletEq: (x: T) => number): DashboardTop[] {
  return [...groupBy(items, name)]
    .map(([n, list]) => ({
      name: n,
      count: list.length,
      units: list.reduce((s, x) => s + units(x), 0),
      palletEq: list.reduce((s, x) => s + palletEq(x), 0),
    }))
    .sort((a, b) => b.palletEq - a.palletEq || b.units - a.units)
    .slice(0, TOP);
}

function bucket(key: string, from: string | null, to: string, inbound: InboundShipment[], outbound: OutboundOrder[]): DashboardBucket {
  const inRange = (d: string | null) => !!d && (from === null || d >= from) && d <= to;
  const lines = inbound.filter((s) => inRange(expectedArrival(s)));
  const orders = outbound.filter((o) => inRange(o.shipDate));
  const pallets = emptySummary();
  for (const s of lines) addLine(pallets, s.pallets, s.quantity);
  return {
    key,
    from,
    to,
    inbound: {
      lines: lines.length,
      pallets,
      topSuppliers: top(lines, (s) => s.supplier, (s) => s.quantity ?? 0, (s) => s.pallets.palletEq ?? 0),
    },
    outbound: {
      ...backlog(orders),
      topShipTos: top(orders, shipToOf, (o) => o.quantity, (o) => o.pallets.palletEq ?? 0),
    },
  };
}

const byShipDate = (a: OutboundOrder, b: OutboundOrder) => (a.shipDate ?? '9999').localeCompare(b.shipDate ?? '9999');

/**
 * Still-to-arrive inbound and open outbound before today and for the next four weeks, plus the
 * exceptions. Overdue outbound is measured against the outbound report date, as on the Outbound page.
 */
export function dashboard(supply: Supply, ratios: RatioLookup, poReportDate: string | null, today: string): DashboardResponse {
  const orders = withSupply(supply, ratios);
  const inbound = withPallets(supply.inbound, ratios);
  const buckets = [
    bucket('before', null, addDays(today, -1), inbound, orders),
    ...Array.from({ length: WEEKS }, (_, i) => bucket(`week-${i}`, addDays(today, 7 * i), addDays(today, 7 * i + 6), inbound, orders)),
  ];

  const horizon = addDays(today, AT_RISK_DAYS - 1);
  const atRisk = orders
    .filter((o) => (o.supply?.readiness === 'late' || o.supply?.readiness === 'short') && o.shipDate && o.shipDate <= horizon)
    .sort(byShipDate);
  const asOf = supply.outbound?.reportDate ?? today;
  const overdue = orders.filter((o) => o.shipDate && o.shipDate < asOf).sort(byShipDate);
  const byReadiness: Partial<Record<Readiness, number>> = {};
  for (const o of overdue) if (o.supply) byReadiness[o.supply.readiness] = (byReadiness[o.supply.readiness] ?? 0) + 1;
  const lateInbound = inbound
    .flatMap((s) => {
      const eta = expectedArrival(s);
      return eta && eta < today ? [{ s, eta }] : [];
    })
    .sort((a, b) => a.eta.localeCompare(b.eta));
  const short = (supply.check?.parts ?? []).filter((p) => p.shortUnits > 0).sort((a, b) => b.shortUnits - a.shortUnits);
  const all = mergeSummaries(buckets.flatMap((b) => [b.inbound.pallets, b.outbound.pallets]));
  const noEta = orders.filter((o) => o.supply?.readiness === 'noEta');

  return {
    asOf: { purchaseOrders: poReportDate, outbound: supply.outbound?.reportDate ?? null, inventory: supply.inventory?.reportDate ?? null },
    buckets,
    exceptions: {
      atRisk: { count: atRisk.length, units: atRisk.reduce((n, o) => n + o.quantity, 0), rows: atRisk.slice(0, TOP).map(orderRow) },
      overdue: { count: overdue.length, byReadiness, rows: overdue.slice(0, TOP).map(orderRow) },
      lateInbound: {
        count: lateInbound.length,
        rows: lateInbound.slice(0, TOP).map(({ s, eta }) => ({
          id: s.id,
          supplier: s.supplier,
          poNumber: s.poNumber,
          lineRef: s.lineRef,
          partNumber: s.partNumber,
          quantity: s.quantity,
          eta,
        })),
      },
      shortParts: {
        count: short.length,
        units: short.reduce((n, p) => n + p.shortUnits, 0),
        rows: short.slice(0, TOP).map((p) => ({
          partNumber: p.partNumber,
          site: p.site,
          description: p.description,
          shortUnits: p.shortUnits,
          firstShortDate: p.firstShortDate,
          orders: p.orders,
        })),
      },
      dataGaps: {
        palletEq: all.palletEq,
        estimatedPalletEq: all.estimatedPalletEq,
        noRatioLines: all.noRatioLines,
        noRatioUnits: all.noRatioUnits,
        noEtaOrders: noEta.length,
        noEtaUnits: noEta.reduce((n, o) => n + o.quantity, 0),
      },
    },
  };
}
