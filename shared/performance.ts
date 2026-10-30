import { addDays, daysBetween } from './dates';

/*
 * On-time measures from uploaded reports. Late = any day after the promised date (no grace).
 * Supplier promises are the first ETA / ETD our uploads recorded for a line, so a supplier that
 * keeps moving its dates to match reality still shows as late.
 */

export const monthOf = (iso: string) => iso.slice(0, 7);

/** The last `n` calendar months up to and including `today`'s, oldest first ("2026-10"). */
export function lastMonths(today: string, n: number): string[] {
  const [y, m] = [+today.slice(0, 4), +today.slice(5, 7)];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : null);

/** On-time share and size of misses for a set of "days late" values (positive = late). */
export interface OnTime {
  count: number;
  onTime: number;
  /** Null with no lines. */
  onTimePct: number | null;
  /** Of late lines only. */
  medianDaysLate: number | null;
}

export function onTime(daysLate: number[]): OnTime {
  const late = daysLate.filter((d) => d > 0);
  return { count: daysLate.length, onTime: daysLate.length - late.length, onTimePct: pct(daysLate.length - late.length, daysLate.length), medianDaysLate: median(late) };
}

/* ---------- Suppliers ---------- */

export interface DateMove {
  reportDate: string;
  from: string | null;
  to: string | null;
}

/** A Supplier POs line (one delivery) as stored, with its date moves across uploads. */
export interface SupplierLineInput {
  id: number;
  supplier: string;
  poNumber: string | null;
  lineRef: string | null;
  asn: string | null;
  trackingNumber: string | null;
  poStatus: 'open' | 'closed' | null;
  status: string;
  branch: string | null;
  partNumber: string | null;
  quantity: number | null;
  /** CRD: Meta PO request ship date. */
  requestDate: string | null;
  /** Latest ETD and ETA in the reports. */
  etd: string | null;
  eta: string | null;
  actualArrivalDate: string | null;
  arrivalSource: string | null;
  /** Report date of the first upload that listed the line. */
  firstReportDate: string;
  etaMoves: DateMove[];
  etdMoves: DateMove[];
}

export interface ReceiptLot {
  poNumber: string;
  poLine: string;
  receiptDate: string;
}

export type Baseline = 'first' | 'final';

export interface SupplierLine {
  id: number;
  supplier: string;
  branch: string | null;
  poNumber: string | null;
  lineRef: string | null;
  asn: string | null;
  partNumber: string | null;
  quantity: number | null;
  requestDate: string | null;
  firstEta: string | null;
  firstEtaSeen: string | null;
  finalEta: string | null;
  firstEtd: string | null;
  firstEtdSeen: string | null;
  finalEtd: string | null;
  /** Received at Wintec: the matching Inventory Summary lot, else the arrival the reports give. */
  arrived: string | null;
  /** The final ETD once the line has shipped (ASN, tracking or closed). */
  shipped: string | null;
  /** Closed in the report or delivered: no longer waiting on the supplier. */
  done: boolean;
  /**
   * `first`: the promise was recorded before the event, so the line is measured against it.
   * `final` (arrival only): received before our first upload listed it, so only its last ETA is
   * known. Suppliers often move the ETA to the receipt date, so this understates lateness.
   */
  arrivalBaseline: Baseline | null;
  arrivalDaysLate: number | null;
  shipBaseline: Baseline | null;
  shipDaysLate: number | null;
  /** ETA moves after it was first recorded, and the days they pushed it later in total. */
  etaMoves: number;
  etaDaysPushed: number;
  /** The supplier's first ETD was after the date Meta asked for it to ship. */
  etdAfterRequest: boolean | null;
}

/** The first date a line had, and the report it was first seen in. */
function firstSeen(current: string | null, moves: DateMove[], firstReportDate: string): { date: string | null; seen: string | null } {
  const sorted = [...moves].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  const first = sorted[0];
  if (!first) return { date: current, seen: current ? firstReportDate : null };
  if (first.from) return { date: first.from, seen: firstReportDate };
  // It had no date when first listed; the first move set one.
  const set = sorted.find((m) => m.to);
  return { date: set?.to ?? current, seen: set?.reportDate ?? (current ? firstReportDate : null) };
}

const stripZeros = (v: string) => v.trim().replace(/^0+(?=\d)/, '');
/** "0159811" + "1-2" → PO line "159811|1": Supplier POs number deliveries of a line as 1-1, 1-2… */
export const poLineOf = (poNumber: string, lineRef: string) => `${stripZeros(poNumber)}|${stripZeros(lineRef.split('-')[0])}`;

const ARRIVED_SOURCES = ['import', 'report_window', 'manual', 'tracking'];
const isDone = (l: SupplierLineInput) => l.poStatus === 'closed' || l.status === 'delivered';

/**
 * When each closed delivery was received. A PO line's lots are handed to its deliveries in ETD
 * order: each takes the first unused lot received on or after its ETD (else the first unused one).
 * Deliveries without a lot fall back to the arrival the reports give, never the supplier's ETA.
 */
export function receivedDates(lines: SupplierLineInput[], lots: ReceiptLot[]): Map<number, string> {
  const lotsByLine = new Map<string, string[]>();
  for (const l of lots) {
    const key = poLineOf(l.poNumber, l.poLine);
    const list = lotsByLine.get(key) ?? [];
    list.push(l.receiptDate);
    lotsByLine.set(key, list);
  }
  const byLine = new Map<string, SupplierLineInput[]>();
  for (const l of lines) {
    if (!isDone(l) || !l.poNumber || !l.lineRef) continue;
    const key = poLineOf(l.poNumber, l.lineRef);
    const list = byLine.get(key) ?? [];
    list.push(l);
    byLine.set(key, list);
  }
  const out = new Map<number, string>();
  for (const [key, deliveries] of byLine) {
    const free = [...(lotsByLine.get(key) ?? [])].sort();
    deliveries.sort((a, b) => (a.etd ?? '').localeCompare(b.etd ?? '') || (a.lineRef ?? '').localeCompare(b.lineRef ?? '', undefined, { numeric: true }));
    for (const d of deliveries) {
      if (!free.length) break;
      const onOrAfter = d.etd ? free.findIndex((r) => r >= d.etd!) : 0;
      out.set(d.id, free.splice(onOrAfter < 0 ? 0 : onOrAfter, 1)[0]);
    }
  }
  for (const l of lines) {
    if (!out.has(l.id) && isDone(l) && l.actualArrivalDate && ARRIVED_SOURCES.includes(l.arrivalSource ?? '')) out.set(l.id, l.actualArrivalDate);
  }
  return out;
}

export function supplierLine(l: SupplierLineInput, arrived: string | null): SupplierLine {
  const eta = firstSeen(l.eta, l.etaMoves, l.firstReportDate);
  const etd = firstSeen(l.etd, l.etdMoves, l.firstReportDate);
  const shipped = l.etd && (l.asn || l.trackingNumber || isDone(l)) ? l.etd : null;

  const measure = (event: string | null, first: { date: string | null; seen: string | null }, final: string | null) => {
    if (!event) return { baseline: null, daysLate: null };
    if (first.date && first.seen && first.seen < event) return { baseline: 'first' as const, daysLate: daysBetween(first.date, event) };
    return final ? { baseline: 'final' as const, daysLate: daysBetween(final, event) } : { baseline: null, daysLate: null };
  };
  const arrival = measure(arrived, eta, l.eta);
  // The ship date is the final ETD, so only a first ETD recorded before it says anything.
  const ship = measure(shipped, etd, null);
  const moves = l.etaMoves.filter((m) => m.from && m.to);
  return {
    id: l.id,
    supplier: l.supplier,
    branch: l.branch,
    poNumber: l.poNumber,
    lineRef: l.lineRef,
    asn: l.asn,
    partNumber: l.partNumber,
    quantity: l.quantity,
    requestDate: l.requestDate,
    firstEta: eta.date,
    firstEtaSeen: eta.seen,
    finalEta: l.eta,
    firstEtd: etd.date,
    firstEtdSeen: etd.seen,
    finalEtd: l.etd,
    arrived,
    shipped,
    done: isDone(l),
    arrivalBaseline: arrival.baseline,
    arrivalDaysLate: arrival.daysLate,
    shipBaseline: ship.baseline,
    shipDaysLate: ship.daysLate,
    etaMoves: moves.length,
    etaDaysPushed: moves.reduce((n, m) => n + Math.max(0, daysBetween(m.from!, m.to!)), 0),
    etdAfterRequest: etd.date && l.requestDate ? etd.date > l.requestDate : null,
  };
}

export const SUPPLIER_STATUSES = ['consistently_late', 'getting_worse', 'reliable'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];
export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = {
  consistently_late: 'Consistently late',
  getting_worse: 'Getting worse',
  reliable: 'Reliable',
};

/** Thresholds for the status flags. */
const FLAG = { monthLines: 5, lateShare: 0.5, months: 3, worseBy: 20, reliablePct: 90, reliableLines: 10 };

export interface MonthPoint {
  month: string;
  count: number;
  onTimePct: number | null;
}

export interface SupplierRating {
  supplier: string;
  status: SupplierStatus | null;
  arrival: OnTime;
  ship: OnTime;
  /** Lines active in the period: arrived, shipped or still open. */
  lines: number;
  openLines: number;
  etaMovesPerLine: number | null;
  /** Share of lines whose first ETD was after Meta's requested ship date. */
  etdAfterRequestPct: number | null;
  /** Arrival on-time % per month, last six months. */
  months: MonthPoint[];
}

interface ScoreOptions {
  from: string;
  to: string;
  today: string;
  /** Also count lines received or shipped before we first saw their promise (vs their final date). */
  includeHistory: boolean;
}

const counts = (b: Baseline | null, include: boolean) => b === 'first' || (include && b === 'final');

function monthly(lines: SupplierLine[], months: string[], kind: 'arrival' | 'ship', includeHistory: boolean): MonthPoint[] {
  return months.map((month) => {
    const days = lines
      .filter((l) => {
        const at = kind === 'arrival' ? l.arrived : l.shipped;
        return at && monthOf(at) === month && counts(kind === 'arrival' ? l.arrivalBaseline : l.shipBaseline, includeHistory);
      })
      .map((l) => (kind === 'arrival' ? l.arrivalDaysLate! : l.shipDaysLate!));
    const o = onTime(days);
    return { month, count: o.count, onTimePct: o.onTimePct };
  });
}

/** Late share of arrivals in [from, to]; null below the minimum sample. */
function lateShare(lines: SupplierLine[], from: string, to: string, includeHistory: boolean, min: number): number | null {
  const days = lines.filter((l) => l.arrived && l.arrived >= from && l.arrived <= to && counts(l.arrivalBaseline, includeHistory)).map((l) => l.arrivalDaysLate!);
  return days.length >= min ? days.filter((d) => d > 0).length / days.length : null;
}

/**
 * Consistently late: the last three months with at least five arrivals were each at least half late.
 * Getting worse: the last 30 days' late share is 20+ points above the 90 days before.
 * Reliable: 90%+ on time over the period, on at least ten arrivals.
 */
export function supplierStatus(lines: SupplierLine[], arrival: OnTime, opts: ScoreOptions): SupplierStatus | null {
  const months = monthly(lines, lastMonths(opts.today, 12), 'arrival', opts.includeHistory).filter((m) => m.count >= FLAG.monthLines);
  const recent = months.slice(-FLAG.months);
  if (recent.length === FLAG.months && recent.every((m) => (m.onTimePct ?? 100) <= (1 - FLAG.lateShare) * 100)) return 'consistently_late';
  const now = lateShare(lines, addDays(opts.today, -29), opts.today, opts.includeHistory, FLAG.monthLines);
  const before = lateShare(lines, addDays(opts.today, -119), addDays(opts.today, -30), opts.includeHistory, FLAG.monthLines);
  if (now !== null && before !== null && (now - before) * 100 >= FLAG.worseBy) return 'getting_worse';
  if (arrival.count >= FLAG.reliableLines && (arrival.onTimePct ?? 0) >= FLAG.reliablePct) return 'reliable';
  return null;
}

export function scoreSuppliers(lines: SupplierLine[], opts: ScoreOptions): SupplierRating[] {
  const inPeriod = (d: string | null) => !!d && d >= opts.from && d <= opts.to;
  const bySupplier = new Map<string, SupplierLine[]>();
  for (const l of lines) {
    const list = bySupplier.get(l.supplier) ?? [];
    list.push(l);
    bySupplier.set(l.supplier, list);
  }
  const months = lastMonths(opts.today, 6);
  const scores: SupplierRating[] = [];
  for (const [supplier, list] of bySupplier) {
    const active = list.filter((l) => inPeriod(l.arrived) || inPeriod(l.shipped) || !l.arrived);
    if (!active.length) continue;
    const arrival = onTime(list.filter((l) => inPeriod(l.arrived) && counts(l.arrivalBaseline, opts.includeHistory)).map((l) => l.arrivalDaysLate!));
    const ship = onTime(list.filter((l) => inPeriod(l.shipped) && counts(l.shipBaseline, opts.includeHistory)).map((l) => l.shipDaysLate!));
    const withRequest = active.filter((l) => l.etdAfterRequest !== null);
    scores.push({
      supplier,
      status: supplierStatus(list, arrival, opts),
      arrival,
      ship,
      lines: active.length,
      openLines: active.filter((l) => !l.arrived).length,
      etaMovesPerLine: active.length ? Math.round((active.reduce((n, l) => n + l.etaMoves, 0) / active.length) * 100) / 100 : null,
      etdAfterRequestPct: pct(withRequest.filter((l) => l.etdAfterRequest).length, withRequest.length),
      months: monthly(list, months, 'arrival', opts.includeHistory),
    });
  }
  const rank = (s: SupplierRating) => (s.status === 'consistently_late' ? 0 : s.status === 'getting_worse' ? 1 : 2);
  return scores.sort((a, b) => rank(a) - rank(b) || (a.arrival.onTimePct ?? 101) - (b.arrival.onTimePct ?? 101) || b.lines - a.lines);
}

export function supplierTrend(lines: SupplierLine[], today: string, includeHistory: boolean, n = 12) {
  const months = lastMonths(today, n);
  return { arrival: monthly(lines, months, 'arrival', includeHistory), ship: monthly(lines, months, 'ship', includeHistory) };
}

/* ---------- Supplier report (Excel export) ---------- */

export interface LineMoves {
  eta: DateMove[];
  etd: DateMove[];
}

export interface SupplierReportRow {
  supplier: string;
  /** As of today, from the last months' arrivals (see supplierStatus). */
  status: SupplierStatus | null;
  /** Received in the range. */
  received: number;
  /** Of those, measured against a promise recorded before they arrived. */
  measured: number;
  onTime: number;
  late: number;
  onTimePct: number | null;
  medianDaysLate: number | null;
  maxDaysLate: number | null;
  /** Still waiting today, past the first ETA. */
  openPastDue: number;
  /** ETA / ETD changes seen in uploads within the range. */
  etaChanges: number;
  etdChanges: number;
  linesWithEtaChanges: number;
  etaDaysPushed: number;
  shipMeasured: number;
  shippedLate: number;
  etdAfterRequestPct: number | null;
}

/** One delivery line in the report; change counts cover every upload, not only the range. */
export interface ReportLine {
  supplier: string;
  branch: string | null;
  poNumber: string | null;
  lineRef: string | null;
  asn: string | null;
  partNumber: string | null;
  quantity: number | null;
  requestDate: string | null;
  firstEta: string | null;
  firstEtaSeen: string | null;
  finalEta: string | null;
  firstEtd: string | null;
  finalEtd: string | null;
  arrived: string | null;
  baseline: Baseline | null;
  /** Arrival days late; for open lines, days past the first ETA today. */
  daysLate: number | null;
  shipped: string | null;
  shipDaysLate: number | null;
  etaChanges: number;
  etdChanges: number;
  etaDaysPushed: number;
}

export interface DateChangeRow {
  supplier: string;
  poNumber: string | null;
  lineRef: string | null;
  asn: string | null;
  quantity: number | null;
  partNumber: string | null;
  branch: string | null;
  reportDate: string;
  field: 'ETA' | 'ETD';
  from: string;
  to: string;
  /** Positive = pushed later. */
  days: number;
}

export interface SupplierMonthRow {
  supplier: string;
  month: string;
  measured: number;
  late: number;
  onTimePct: number | null;
  medianDaysLate: number | null;
  etaChanges: number;
}

export interface SupplierReportData {
  suppliers: SupplierReportRow[];
  /** Received late in the range, worst first per supplier. */
  late: ReportLine[];
  /** Not received today and past their first ETA, most overdue first. */
  openPastDue: ReportLine[];
  changes: DateChangeRow[];
  months: SupplierMonthRow[];
}

/** Calendar months from `from`'s to `to`'s, oldest first. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = [+from.slice(0, 4), +from.slice(5, 7)];
  const end = monthOf(to);
  for (let month = monthOf(from); month <= end; month = `${y}-${String(m).padStart(2, '0')}`) {
    out.push(month);
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
  return out;
}

const realMoves = (moves: DateMove[]) => moves.filter((m): m is DateMove & { from: string; to: string } => !!m.from && !!m.to);

/**
 * Per supplier: late deliveries and how often their ETA/ETD changed. Deliveries count when received
 * in [from, to]; changes count when an upload in [from, to] recorded them; open past-due is as of today.
 */
export function supplierReport(lines: SupplierLine[], moves: Map<number, LineMoves>, opts: ScoreOptions): SupplierReportData {
  const inRange = (d: string | null) => !!d && d >= opts.from && d <= opts.to;
  const movesOf = (l: SupplierLine) => ({ eta: realMoves(moves.get(l.id)?.eta ?? []), etd: realMoves(moves.get(l.id)?.etd ?? []) });
  const reportLine = (l: SupplierLine, daysLate: number | null): ReportLine => {
    const m = movesOf(l);
    return {
      supplier: l.supplier,
      branch: l.branch,
      poNumber: l.poNumber,
      lineRef: l.lineRef,
      asn: l.asn,
      partNumber: l.partNumber,
      quantity: l.quantity,
      requestDate: l.requestDate,
      firstEta: l.firstEta,
      firstEtaSeen: l.firstEtaSeen,
      finalEta: l.finalEta,
      firstEtd: l.firstEtd,
      finalEtd: l.finalEtd,
      arrived: l.arrived,
      baseline: l.arrivalBaseline,
      daysLate,
      shipped: l.shipped,
      shipDaysLate: l.shipDaysLate,
      etaChanges: m.eta.length,
      etdChanges: m.etd.length,
      etaDaysPushed: l.etaDaysPushed,
    };
  };
  const measured = (l: SupplierLine) => inRange(l.arrived) && counts(l.arrivalBaseline, opts.includeHistory);
  const pastDueDays = (l: SupplierLine) => {
    const promise = l.firstEta ?? l.finalEta;
    return !l.arrived && !l.done && promise && promise < opts.today ? daysBetween(promise, opts.today) : null;
  };

  const bySupplier = new Map<string, SupplierLine[]>();
  for (const l of lines) bySupplier.set(l.supplier, [...(bySupplier.get(l.supplier) ?? []), l]);
  const monthList = monthsBetween(opts.from, opts.to);

  const suppliers: SupplierReportRow[] = [];
  const months: SupplierMonthRow[] = [];
  const changes: DateChangeRow[] = [];
  for (const [supplier, list] of bySupplier) {
    const days = list.filter(measured).map((l) => l.arrivalDaysLate!);
    const arrival = onTime(days);
    const shipDays = list.filter((l) => inRange(l.shipped) && counts(l.shipBaseline, opts.includeHistory)).map((l) => l.shipDaysLate!);
    let etaChanges = 0;
    let etdChanges = 0;
    let linesWithEtaChanges = 0;
    let etaDaysPushed = 0;
    for (const l of list) {
      const m = movesOf(l);
      const eta = m.eta.filter((x) => inRange(x.reportDate));
      const etd = m.etd.filter((x) => inRange(x.reportDate));
      etaChanges += eta.length;
      etdChanges += etd.length;
      if (eta.length) linesWithEtaChanges++;
      etaDaysPushed += eta.reduce((n, x) => n + Math.max(0, daysBetween(x.from, x.to)), 0);
      for (const [field, found] of [['ETA', eta], ['ETD', etd]] as const) {
        for (const x of found) {
          changes.push({ supplier, poNumber: l.poNumber, lineRef: l.lineRef, asn: l.asn, quantity: l.quantity, partNumber: l.partNumber, branch: l.branch, reportDate: x.reportDate, field, from: x.from, to: x.to, days: daysBetween(x.from, x.to) });
        }
      }
    }
    const received = list.filter((l) => inRange(l.arrived)).length;
    const openPastDue = list.filter((l) => pastDueDays(l) !== null).length;
    if (!received && !openPastDue && !etaChanges && !etdChanges) continue;
    const withRequest = list.filter((l) => (inRange(l.arrived) || !l.arrived) && l.etdAfterRequest !== null);
    suppliers.push({
      supplier,
      status: supplierStatus(list, arrival, opts),
      received,
      measured: arrival.count,
      onTime: arrival.onTime,
      late: arrival.count - arrival.onTime,
      onTimePct: arrival.onTimePct,
      medianDaysLate: arrival.medianDaysLate,
      maxDaysLate: days.some((d) => d > 0) ? Math.max(...days) : null,
      openPastDue,
      etaChanges,
      etdChanges,
      linesWithEtaChanges,
      etaDaysPushed,
      shipMeasured: shipDays.length,
      shippedLate: shipDays.filter((d) => d > 0).length,
      etdAfterRequestPct: pct(withRequest.filter((l) => l.etdAfterRequest).length, withRequest.length),
    });
    for (const month of monthList) {
      const o = onTime(list.filter((l) => measured(l) && monthOf(l.arrived!) === month).map((l) => l.arrivalDaysLate!));
      const moved = list.reduce((n, l) => n + movesOf(l).eta.filter((x) => inRange(x.reportDate) && monthOf(x.reportDate) === month).length, 0);
      if (o.count || moved) months.push({ supplier, month, measured: o.count, late: o.count - o.onTime, onTimePct: o.onTimePct, medianDaysLate: o.medianDaysLate, etaChanges: moved });
    }
  }

  const rank = (s: SupplierReportRow) => (s.status === 'consistently_late' ? 0 : s.status === 'getting_worse' ? 1 : 2);
  suppliers.sort((a, b) => rank(a) - rank(b) || b.late - a.late || b.openPastDue - a.openPastDue || b.etaChanges - a.etaChanges || a.supplier.localeCompare(b.supplier));
  const order = new Map(suppliers.map((s, i) => [s.supplier, i]));
  const bySupplierOrder = (a: { supplier: string }, b: { supplier: string }) => order.get(a.supplier)! - order.get(b.supplier)!;
  return {
    suppliers,
    late: lines
      .filter((l) => measured(l) && l.arrivalDaysLate! > 0)
      .map((l) => reportLine(l, l.arrivalDaysLate))
      .sort((a, b) => bySupplierOrder(a, b) || b.daysLate! - a.daysLate!),
    openPastDue: lines
      .filter((l) => pastDueDays(l) !== null)
      .map((l) => reportLine(l, pastDueDays(l)))
      .sort((a, b) => b.daysLate! - a.daysLate! || bySupplierOrder(a, b)),
    changes: changes.sort((a, b) => bySupplierOrder(a, b) || a.reportDate.localeCompare(b.reportDate) || (a.poNumber ?? '').localeCompare(b.poNumber ?? '')),
    months: months.sort((a, b) => bySupplierOrder(a, b) || a.month.localeCompare(b.month)),
  };
}

/* ---------- Our shipping ---------- */

export interface ShippedLineInput {
  id: number;
  shipTo: string | null;
  odmPo: string | null;
  partNumber: string | null;
  branch: string | null;
  quantity: number | null;
  shipDate: string;
  soEtd: string | null;
}

/** What one ODM Open Order report said about an order (EMS PO# + CPN), earliest pieces. */
export interface OrderSeen {
  emsPo: string;
  cpn: string;
  reportDate: string;
  confirmedShipDate: string | null;
  dockDate: string | null;
}

export const orderKey = (po: string | null, part: string | null) => `${(po ?? '').trim()}\u0000${(part ?? '').trim()}`;

export interface ShippedLine extends ShippedLineInput {
  /** From the first report that listed the order before it shipped. */
  firstConfirmed: string | null;
  firstRequest: string | null;
  lastConfirmed: string | null;
  /** How many times the confirmed ship date changed while we watched. */
  confirmedMoves: number;
  vsConfirmed: number | null;
  vsRequest: number | null;
  vsEtd: number | null;
}

/** Matches each shipment to the ODM reports that listed its order before it shipped. */
export function matchShipments(shipments: ShippedLineInput[], seen: OrderSeen[]): ShippedLine[] {
  const byOrder = new Map<string, OrderSeen[]>();
  for (const s of seen) {
    const key = orderKey(s.emsPo, s.cpn);
    const list = byOrder.get(key) ?? [];
    list.push(s);
    byOrder.set(key, list);
  }
  for (const list of byOrder.values()) list.sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  return shipments.map((s) => {
    const before = (byOrder.get(orderKey(s.odmPo, s.partNumber)) ?? []).filter((o) => o.reportDate <= s.shipDate);
    const confirmed = before.map((o) => o.confirmedShipDate).filter((d): d is string => !!d);
    const firstConfirmed = confirmed[0] ?? null;
    const firstRequest = before.find((o) => o.dockDate)?.dockDate ?? null;
    return {
      ...s,
      firstConfirmed,
      firstRequest,
      lastConfirmed: confirmed[confirmed.length - 1] ?? null,
      confirmedMoves: confirmed.filter((d, i) => i > 0 && d !== confirmed[i - 1]).length,
      vsConfirmed: firstConfirmed ? daysBetween(firstConfirmed, s.shipDate) : null,
      vsRequest: firstRequest ? daysBetween(firstRequest, s.shipDate) : null,
      vsEtd: s.soEtd ? daysBetween(s.soEtd, s.shipDate) : null,
    };
  });
}

export const SHIP_BASELINES = ['vsConfirmed', 'vsRequest', 'vsEtd'] as const;
export type ShipBaseline = (typeof SHIP_BASELINES)[number];
export const SHIP_BASELINE_LABELS: Record<ShipBaseline, string> = {
  vsConfirmed: 'Wintec confirmed ship date',
  vsRequest: 'Customer request (EMS dock)',
  vsEtd: 'SO ETD',
};

export type ShipOnTime = Record<ShipBaseline, OnTime>;

export function shipOnTime(lines: ShippedLine[]): ShipOnTime {
  return Object.fromEntries(
    SHIP_BASELINES.map((b) => [b, onTime(lines.map((l) => l[b]).filter((d): d is number => d !== null))]),
  ) as ShipOnTime;
}

export interface ShipGroup extends ShipOnTime {
  name: string;
  shipments: number;
  units: number;
}

export function shipGroups(lines: ShippedLine[], key: (l: ShippedLine) => string): ShipGroup[] {
  const groups = new Map<string, ShippedLine[]>();
  for (const l of lines) {
    const k = key(l);
    const list = groups.get(k) ?? [];
    list.push(l);
    groups.set(k, list);
  }
  return [...groups]
    .map(([name, list]) => ({ name, shipments: list.length, units: list.reduce((n, l) => n + (l.quantity ?? 0), 0), ...shipOnTime(list) }))
    .sort((a, b) => b.shipments - a.shipments);
}

export function shipTrend(lines: ShippedLine[], months: string[]): ({ month: string } & Record<ShipBaseline, MonthPoint>)[] {
  return months.map((month) => {
    const o = shipOnTime(lines.filter((l) => monthOf(l.shipDate) === month));
    return {
      month,
      ...(Object.fromEntries(SHIP_BASELINES.map((b) => [b, { month, count: o[b].count, onTimePct: o[b].onTimePct }])) as Record<ShipBaseline, MonthPoint>),
    };
  });
}

/* ---------- Receiving ---------- */

export const AGE_BUCKETS = [
  { key: 'd1_7', label: '1–7 days', max: 7 },
  { key: 'd8_14', label: '8–14 days', max: 14 },
  { key: 'd15_30', label: '15–30 days', max: 30 },
  { key: 'd30', label: 'Over 30 days', max: Infinity },
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number]['key'];
export const ageBucket = (days: number): AgeBucket => AGE_BUCKETS.find((b) => days <= b.max)!.key;

/** Open lines whose ETA had passed, as one report listed them. */
export interface PastDueRow {
  reportDate: string;
  branch: string | null;
  daysPastDue: number;
  quantity: number | null;
}

export interface PastDuePoint extends Record<AgeBucket, number> {
  reportDate: string;
  lines: number;
  units: number;
}

/** Past-due lines per report date (optionally one branch), by how long past their ETA. */
export function pastDueTrend(rows: PastDueRow[], branch?: string): PastDuePoint[] {
  const byDate = new Map<string, PastDuePoint>();
  for (const r of rows) {
    if (branch && r.branch !== branch) continue;
    let p = byDate.get(r.reportDate);
    if (!p) {
      p = { reportDate: r.reportDate, lines: 0, units: 0, d1_7: 0, d8_14: 0, d15_30: 0, d30: 0 };
      byDate.set(r.reportDate, p);
    }
    p.lines++;
    p.units += r.quantity ?? 0;
    p[ageBucket(r.daysPastDue)]++;
  }
  return [...byDate.values()].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
}

/** Median days from receiving stock to shipping it, per branch and ship month. */
export function receiptToShip(lines: { branch: string | null; receiptDate: string | null; shipDate: string }[], months: string[]) {
  const branches = new Map<string, Map<string, number[]>>();
  for (const l of lines) {
    if (!l.receiptDate) continue;
    const month = monthOf(l.shipDate);
    if (!months.includes(month)) continue;
    const b = l.branch ?? 'Unknown';
    const m = branches.get(b) ?? new Map<string, number[]>();
    const list = m.get(month) ?? [];
    list.push(daysBetween(l.receiptDate, l.shipDate));
    m.set(month, list);
    branches.set(b, m);
  }
  return [...branches]
    .map(([branch, m]) => {
      const all = [...m.values()].flat();
      return { branch, shipments: all.length, medianDays: median(all), months: months.map((month) => ({ month, count: m.get(month)?.length ?? 0, medianDays: median(m.get(month) ?? []) })) };
    })
    .sort((a, b) => b.shipments - a.shipments);
}
