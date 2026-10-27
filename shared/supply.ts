/**
 * Can open sales orders ship? Matches each order against stock and inbound supply for its part at
 * its warehouse site, using the Inventory Summary tab (stock), the ODM reservation status and the
 * open supplier PO lines (inbound, with ETAs).
 */

/** Best to worst. */
export const READINESS = ['ready', 'stock', 'inbound', 'noEta', 'late', 'short'] as const;
export type Readiness = (typeof READINESS)[number];

export const READINESS_LABELS: Record<Readiness, string> = {
  ready: 'Reserved in stock',
  stock: 'Covered by stock',
  inbound: 'Inbound on time',
  noEta: 'Inbound, no ETA',
  late: 'Inbound late',
  short: 'Short',
};

/** Branches whose stock can't be shipped as is. */
const HELD_BRANCH = /QUARANTINE|[-_ ]QUA$|QRT|RMA|CYCLE ?COUNT|IN TRANSIT/i;

export const isHeldBranch = (branch: string) => HELD_BRANCH.test(branch);

/**
 * The warehouse a branch belongs to: its first two segments, so JIT-MSUS-QUARANTINE and
 * JIT-MSUS-META are both JIT-MSUS. ODM warehouses and PO branches use the same codes.
 */
export function siteOf(branch: string | null | undefined): string {
  if (!branch) return '';
  return branch.trim().toUpperCase().split('-').slice(0, 2).join('-');
}

export type Reservation = 'physical' | 'ordered' | 'onOrder';

/** ODM STATUSISSUE: Reserved Physical (in stock), Reserved ordered (against an inbound PO), On order (no supply yet). */
export function reservationOf(status: string | null): Reservation {
  if (/physical/i.test(status ?? '')) return 'physical';
  if (/reserved\s*order/i.test(status ?? '')) return 'ordered';
  return 'onOrder';
}

export interface SupplyPosition {
  partNumber: string;
  branch: string;
  onhand: number;
  reserved: number;
  available: number;
  onReceipt: number;
  description?: string | null;
  commodity?: string | null;
}

export interface SupplyOrder {
  id: number;
  cpn: string | null;
  warehouse: string | null;
  status: string | null;
  quantity: number;
  shipDate: string | null;
  soNumber: string;
}

export interface SupplyInbound {
  id: number;
  partNumber: string | null;
  branch: string | null;
  quantity: number | null;
  eta: string | null;
  /** Supplier's ship date (ETD); bounds the arrival when there's no ETA yet. */
  shipDate: string | null;
}

export interface OrderSupply {
  readiness: Readiness;
  /** ETA of the last inbound line the order needs, when it relies on inbound. */
  coveredBy: string | null;
  /** Latest supplier ship date among the inbound lines it needs that have no ETA yet. */
  supplierShipDate: string | null;
  /** Units no stock or inbound covers. */
  shortUnits: number;
}

export interface PartSupply {
  partNumber: string;
  site: string;
  description: string | null;
  commodity: string | null;
  /** Free stock in shippable branches. */
  available: number;
  /** On hand in quarantine, RMA, cycle-count and in-transit branches. */
  held: number;
  onhand: number;
  reserved: number;
  /** Open with suppliers, per the Inventory Summary. */
  onReceipt: number;
  nextInboundEta: string | null;
  demand: Record<Reservation, number>;
  orders: number;
  shortUnits: number;
  firstShortDate: string | null;
  lateUnits: number;
  /** Worst readiness among its orders; null with no open orders. */
  readiness: Readiness | null;
}

export interface SupplyCheck {
  parts: PartSupply[];
  orders: Map<number, OrderSupply>;
}

const worse = (a: Readiness, b: Readiness) => (READINESS.indexOf(a) >= READINESS.indexOf(b) ? a : b);
const byDate = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b));

interface Lot {
  qty: number;
  eta: string | null;
  etd: string | null;
}

interface Taken {
  got: number;
  /** Latest ETA relied on. */
  latest: string | null;
  noEta: boolean;
  /** Latest ETD of the lots with no ETA. */
  latestEtd: string | null;
}

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/** Takes up to `need` from the front of the pool; returns what it got and the dates it relied on. */
function take(pool: Lot[], need: number): Taken {
  const t: Taken = { got: 0, latest: null, noEta: false, latestEtd: null };
  while (t.got < need && pool.length) {
    const lot = pool[0];
    const n = Math.min(lot.qty, need - t.got);
    t.got += n;
    lot.qty -= n;
    if (lot.eta === null) {
      t.noEta = true;
      t.latestEtd = later(t.latestEtd, lot.etd);
    } else t.latest = later(t.latest, lot.eta);
    if (lot.qty <= 0) pool.shift();
  }
  return t;
}

/** Late when an ETA, or a supplier ship date, is already after the order's ship date. */
function inboundReadiness(shipDate: string | null, t: Taken): Readiness {
  const after = (d: string | null) => shipDate !== null && d !== null && d > shipDate;
  if (after(t.latest) || after(t.latestEtd)) return 'late';
  return t.noEta ? 'noEta' : 'inbound';
}

function emptyPart(partNumber: string, site: string): PartSupply {
  return {
    partNumber,
    site,
    description: null,
    commodity: null,
    available: 0,
    held: 0,
    onhand: 0,
    reserved: 0,
    onReceipt: 0,
    nextInboundEta: null,
    demand: { physical: 0, ordered: 0, onOrder: 0 },
    orders: 0,
    shortUnits: 0,
    firstShortDate: null,
    lateUnits: 0,
    readiness: null,
  };
}

/**
 * Per part and site, in ship-date order (unscheduled last):
 * - Reserved Physical orders are ready: the stock is already set aside.
 * - Reserved ordered orders take inbound lines, earliest ETA first.
 * - On order orders take free stock, then the inbound left over, and are short for the rest.
 * Inbound covering an order is late when its ETA (or, before there's an ETA, the supplier's ship
 * date) is after the order's ship date, and "no ETA" when it isn't known yet.
 */
export function checkSupply(positions: SupplyPosition[], orders: SupplyOrder[], inbound: SupplyInbound[]): SupplyCheck {
  const parts = new Map<string, PartSupply>();
  const key = (part: string, site: string) => `${part}\u0000${site}`;
  const partFor = (partNumber: string, site: string) => {
    const k = key(partNumber, site);
    let p = parts.get(k);
    if (!p) parts.set(k, (p = emptyPart(partNumber, site)));
    return p;
  };

  for (const pos of positions) {
    const p = partFor(pos.partNumber, siteOf(pos.branch));
    if (isHeldBranch(pos.branch)) p.held += pos.onhand;
    else {
      p.available += pos.available;
      p.onhand += pos.onhand;
      p.reserved += pos.reserved;
    }
    p.onReceipt += pos.onReceipt;
    p.description ??= pos.description ?? null;
    p.commodity ??= pos.commodity ?? null;
  }

  // Sorted by ETA, so each pool's first dated lot is the part's next inbound.
  const lots = new Map<string, Lot[]>();
  for (const line of [...inbound].sort((a, b) => byDate(a.eta, b.eta))) {
    if (!line.partNumber || !line.quantity || line.quantity <= 0) continue;
    const k = key(line.partNumber, siteOf(line.branch));
    const pool = lots.get(k) ?? [];
    pool.push({ qty: line.quantity, eta: line.eta, etd: line.eta ? null : line.shipDate });
    lots.set(k, pool);
    const p = partFor(line.partNumber, siteOf(line.branch));
    p.nextInboundEta ??= line.eta;
  }

  const result = new Map<number, OrderSupply>();
  const sorted = [...orders].sort((a, b) => byDate(a.shipDate, b.shipDate) || a.soNumber.localeCompare(b.soNumber));
  const byPart = new Map<string, SupplyOrder[]>();
  for (const o of sorted) {
    if (!o.cpn) continue;
    const k = key(o.cpn, siteOf(o.warehouse));
    const list = byPart.get(k) ?? [];
    list.push(o);
    byPart.set(k, list);
  }

  for (const [k, list] of byPart) {
    const p = partFor(list[0].cpn!, siteOf(list[0].warehouse));
    const pool = lots.get(k) ?? [];
    // Supply the report counts as on receipt but no open PO line explains: inbound with no ETA.
    const timed = pool.reduce((n, l) => n + l.qty, 0);
    if (p.onReceipt > timed) pool.push({ qty: p.onReceipt - timed, eta: null, etd: null });
    const stock: Lot[] = [{ qty: Math.max(0, p.available), eta: null, etd: null }];

    const set = (o: SupplyOrder, s: OrderSupply) => {
      result.set(o.id, s);
      p.readiness = p.readiness ? worse(p.readiness, s.readiness) : s.readiness;
      if (s.readiness === 'late') p.lateUnits += o.quantity;
      if (s.shortUnits > 0) {
        p.shortUnits += s.shortUnits;
        if (o.shipDate && (!p.firstShortDate || o.shipDate < p.firstShortDate)) p.firstShortDate = o.shipDate;
      }
    };

    for (const o of list) {
      p.orders++;
      p.demand[reservationOf(o.status)] += o.quantity;
    }
    for (const o of list.filter((x) => reservationOf(x.status) === 'physical')) {
      set(o, { readiness: 'ready', coveredBy: null, supplierShipDate: null, shortUnits: 0 });
    }
    // Reserved against inbound: the ERP has matched supply, so a gap means we can't see its ETA.
    for (const o of list.filter((x) => reservationOf(x.status) === 'ordered')) {
      const t = take(pool, o.quantity);
      if (t.got < o.quantity) t.noEta = true;
      set(o, { readiness: inboundReadiness(o.shipDate, t), coveredBy: t.latest, supplierShipDate: t.latestEtd, shortUnits: 0 });
    }
    for (const o of list.filter((x) => reservationOf(x.status) === 'onOrder')) {
      const fromStock = take(stock, o.quantity).got;
      const t = take(pool, o.quantity - fromStock);
      const shortUnits = o.quantity - fromStock - t.got;
      const readiness: Readiness = shortUnits > 0 ? 'short' : t.got > 0 ? inboundReadiness(o.shipDate, t) : 'stock';
      set(o, { readiness, coveredBy: t.latest, supplierShipDate: t.latestEtd, shortUnits });
    }
  }

  return {
    parts: [...parts.values()].sort(
      (a, b) =>
        READINESS.indexOf(b.readiness ?? 'ready') - READINESS.indexOf(a.readiness ?? 'ready') ||
        b.shortUnits - a.shortUnits ||
        b.lateUnits - a.lateUnits ||
        a.partNumber.localeCompare(b.partNumber),
    ),
    orders: result,
  };
}
