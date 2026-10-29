import { daysBetween } from './dates';
import { siteOf } from './supply';

/** What moved on one sales order line (SO# + CPN) between two ODM Open Order reports. */
export const ORDER_CHANGE_KINDS = ['new', 'gone', 'confirmed_date', 'dock_date', 'scheduled_date', 'quantity', 'status'] as const;
export type OrderChangeKind = (typeof ORDER_CHANGE_KINDS)[number];

/**
 * Causes the report itself shows. The report has no reason column, so these are what moved at the
 * same time; an empty list means the report shows no cause.
 */
export const ORDER_CHANGE_CAUSES = ['customer', 'reservation', 'inbound_eta', 'quantity'] as const;
export type OrderChangeCause = (typeof ORDER_CHANGE_CAUSES)[number];

export const ORDER_CHANGE_LABELS: Record<OrderChangeKind, string> = {
  new: 'New order',
  gone: 'No longer listed',
  confirmed_date: 'Confirmed ship date',
  dock_date: 'Customer request (EMS dock)',
  scheduled_date: 'System schedule date',
  quantity: 'Quantity',
  status: 'Reservation',
};

export const ORDER_CAUSE_LABELS: Record<OrderChangeCause, string> = {
  customer: 'customer moved the dock date',
  reservation: 'reservation changed',
  inbound_eta: 'inbound ETA for the part moved',
  quantity: 'quantity changed',
};

export interface OrderChange {
  soNumber: string;
  cpn: string | null;
  shipTo: string | null;
  warehouse: string | null;
  kind: OrderChangeKind;
  from: string | null;
  to: string | null;
  causes: OrderChangeCause[];
}

/** The fields of a stored order the diff reads. */
export interface OrderRowForDiff {
  soNumber: string;
  cpn: string | null;
  shipTo: string | null;
  warehouse: string | null;
  status: string | null;
  quantity: number;
  confirmedShipDate: string | null;
  dockDate: string | null;
  scheduledShipDate: string | null;
}

/** One SO# + CPN, its reservation pieces summed. Dates are the earliest piece's. */
export interface OrderLineState {
  soNumber: string;
  cpn: string | null;
  shipTo: string | null;
  warehouse: string | null;
  quantity: number;
  confirmedShipDate: string | null;
  dockDate: string | null;
  scheduledShipDate: string | null;
  unitsByStatus: Record<string, number>;
}

export const orderLineKey = (soNumber: string, cpn: string | null) => `${soNumber}\u0000${cpn ?? ''}`;
/** Matches an inbound ETA move to orders for the same part at the same site. */
export const etaMoveKey = (partNumber: string | null, branch: string | null) => `${partNumber ?? ''}\u0000${siteOf(branch)}`;

const earliest = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a < b ? a : b);

export function summarizeLines(rows: OrderRowForDiff[]): Map<string, OrderLineState> {
  const lines = new Map<string, OrderLineState>();
  for (const r of rows) {
    const key = orderLineKey(r.soNumber, r.cpn);
    let line = lines.get(key);
    if (!line) {
      line = { soNumber: r.soNumber, cpn: r.cpn, shipTo: r.shipTo, warehouse: r.warehouse, quantity: 0, confirmedShipDate: null, dockDate: null, scheduledShipDate: null, unitsByStatus: {} };
      lines.set(key, line);
    }
    line.shipTo ??= r.shipTo;
    line.warehouse ??= r.warehouse;
    line.quantity += r.quantity;
    line.confirmedShipDate = earliest(line.confirmedShipDate, r.confirmedShipDate);
    line.dockDate = earliest(line.dockDate, r.dockDate);
    line.scheduledShipDate = earliest(line.scheduledShipDate, r.scheduledShipDate);
    const status = r.status ?? 'Unknown';
    line.unitsByStatus[status] = (line.unitsByStatus[status] ?? 0) + r.quantity;
  }
  return lines;
}

/** "On order 300 · Reserved ordered 200", largest first, so equal splits compare equal. */
export function statusText(units: Record<string, number>): string {
  return Object.entries(units)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([s, n]) => `${s} ${n}`)
    .join(' · ');
}

/**
 * Changes from `prev` to `cur`, per SO# + CPN. Date and quantity changes carry the causes the
 * report shows: the dock date moved too (customer), units moved between reservation statuses,
 * an inbound PO line for the part at the same site changed ETA (`etaMoves`, see `etaMoveKey`),
 * or the quantity changed.
 */
export function diffOrders(prev: OrderRowForDiff[], cur: OrderRowForDiff[], etaMoves: Set<string>): OrderChange[] {
  const before = summarizeLines(prev);
  const now = summarizeLines(cur);
  const out: OrderChange[] = [];
  const base = (l: OrderLineState) => ({ soNumber: l.soNumber, cpn: l.cpn, shipTo: l.shipTo, warehouse: l.warehouse });

  for (const [key, l] of now) {
    const p = before.get(key);
    if (!p) {
      out.push({ ...base(l), kind: 'new', from: null, to: String(l.quantity), causes: [] });
      continue;
    }
    const dockMoved = p.dockDate !== l.dockDate;
    const statusMoved = statusText(p.unitsByStatus) !== statusText(l.unitsByStatus);
    const qtyMoved = p.quantity !== l.quantity;
    const causes: OrderChangeCause[] = [];
    if (dockMoved) causes.push('customer');
    if (statusMoved) causes.push('reservation');
    if (etaMoves.has(etaMoveKey(l.cpn, l.warehouse))) causes.push('inbound_eta');
    if (qtyMoved) causes.push('quantity');

    const push = (kind: OrderChangeKind, from: string | null, to: string | null, c: OrderChangeCause[] = []) => {
      if (from !== to) out.push({ ...base(l), kind, from, to, causes: c });
    };
    push('confirmed_date', p.confirmedShipDate, l.confirmedShipDate, causes);
    push('dock_date', p.dockDate, l.dockDate, ['customer']);
    push('scheduled_date', p.scheduledShipDate, l.scheduledShipDate, causes);
    push('quantity', String(p.quantity), String(l.quantity));
    push('status', statusText(p.unitsByStatus), statusText(l.unitsByStatus));
  }
  for (const [key, p] of before) {
    if (!now.has(key)) out.push({ ...base(p), kind: 'gone', from: String(p.quantity), to: null, causes: [] });
  }
  return out;
}

/** Days a date moved: positive = later. Null when either side is blank. */
export function dateShift(c: Pick<OrderChange, 'from' | 'to'>): number | null {
  return c.from && c.to ? daysBetween(c.from, c.to) : null;
}

export interface OrderChangeSummary {
  added: number;
  gone: number;
  /** Confirmed ship date moved later. */
  pushedOut: number;
  pulledIn: number;
  /** Got a confirmed ship date for the first time. */
  newlyConfirmed: number;
  dockMoved: number;
  quantity: number;
  status: number;
  /** Confirmed date moves with no cause in the report. */
  noCause: number;
}

export function summarizeChanges(changes: Pick<OrderChange, 'kind' | 'from' | 'to' | 'causes'>[]): OrderChangeSummary {
  const s: OrderChangeSummary = { added: 0, gone: 0, pushedOut: 0, pulledIn: 0, newlyConfirmed: 0, dockMoved: 0, quantity: 0, status: 0, noCause: 0 };
  for (const c of changes) {
    if (c.kind === 'new') s.added++;
    else if (c.kind === 'gone') s.gone++;
    else if (c.kind === 'dock_date') s.dockMoved++;
    else if (c.kind === 'quantity') s.quantity++;
    else if (c.kind === 'status') s.status++;
    else if (c.kind === 'confirmed_date') {
      const shift = dateShift(c);
      if (shift === null) {
        if (!c.from && c.to) s.newlyConfirmed++;
      } else if (shift > 0) s.pushedOut++;
      else s.pulledIn++;
      if (shift !== null && c.causes.length === 0) s.noCause++;
    }
  }
  return s;
}

/** The "changed since last report" filters on the Outbound page. */
export const ORDER_CHANGE_FILTERS = ['any', 'pushed', 'pulled', 'dock', 'new'] as const;
export type OrderChangeFilter = (typeof ORDER_CHANGE_FILTERS)[number];

export function matchesChangeFilter(changes: Pick<OrderChange, 'kind' | 'from' | 'to'>[], f: OrderChangeFilter): boolean {
  const confirmed = changes.find((c) => c.kind === 'confirmed_date');
  const shift = confirmed ? dateShift(confirmed) : null;
  switch (f) {
    case 'any':
      return changes.length > 0;
    case 'pushed':
      return shift !== null && shift > 0;
    case 'pulled':
      return shift !== null && shift < 0;
    case 'dock':
      return changes.some((c) => c.kind === 'dock_date');
    case 'new':
      return changes.some((c) => c.kind === 'new');
  }
}
