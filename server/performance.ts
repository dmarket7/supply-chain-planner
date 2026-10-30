import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { addDays, daysBetween } from '../shared/dates';
import {
  matchShipments,
  pastDueTrend,
  receiptToShip,
  receivedDates,
  scoreSuppliers,
  shipGroups,
  shipOnTime,
  shipTrend,
  supplierLine,
  supplierTrend,
  lastMonths,
  onTime,
  type DateMove,
  type OrderSeen,
  type PastDueRow,
  type SupplierLine,
  type SupplierLineInput,
} from '../shared/performance';
import type { ReceivingResponse, ShippingPerformanceResponse, SupplierDetailResponse, SupplierPerformanceResponse } from '../shared/types';
import type { Db } from './db/client';
import { imports, lineChanges, outboundOrders, outboundSnapshots, poLineVersions, poReceipts, poReportLines, shipments, soShipments, suppliers } from './db/schema';
import { activeImport } from './poHistory';
import { branchFilter, NO_BRANCH } from './routes/common';

export const PERIODS = [90, 180, 365] as const;
export const periodOf = (v: string | undefined) => (PERIODS as readonly number[]).includes(Number(v)) ? Number(v) : 90;

/** Every Supplier POs line with its first ETA/ETD, date moves and when it was received. */
export async function loadSupplierLines(db: Db, branch: string | undefined): Promise<{ lines: SupplierLine[]; firstUpload: string | null }> {
  const [rows, moves, lots, [first]] = await Promise.all([
    db
      .select({
        id: shipments.id,
        supplier: suppliers.name,
        poNumber: shipments.poNumber,
        lineRef: shipments.lineRef,
        asn: shipments.asn,
        trackingNumber: shipments.trackingNumber,
        poStatus: shipments.poStatus,
        status: shipments.status,
        branch: shipments.branch,
        partNumber: shipments.partNumber,
        quantity: shipments.quantity,
        requestDate: shipments.requestDate,
        etd: shipments.shipDate,
        eta: shipments.promisedArrivalDate,
        actualArrivalDate: shipments.actualArrivalDate,
        arrivalSource: shipments.arrivalSource,
        firstReportDate: imports.reportDate,
      })
      .from(shipments)
      .innerJoin(suppliers, eq(suppliers.id, shipments.supplierId))
      .leftJoin(imports, eq(imports.id, shipments.firstImportId))
      .where(branchFilter(branch)),
    db
      .select({ shipmentId: lineChanges.shipmentId, kind: lineChanges.kind, reportDate: lineChanges.reportDate, from: lineChanges.fromValue, to: lineChanges.toValue })
      .from(lineChanges)
      .where(and(inArray(lineChanges.kind, ['eta_changed', 'ship_date_changed']), isNotNull(lineChanges.importId))),
    db.select({ poNumber: poReceipts.poNumber, poLine: poReceipts.poLine, receiptDate: poReceipts.receiptDate }).from(poReceipts),
    db.select({ reportDate: sql<string | null>`min(${imports.reportDate})::text` }).from(imports).where(activeImport),
  ]);
  const movesBy = new Map<number, { eta: DateMove[]; etd: DateMove[] }>();
  for (const m of moves) {
    const entry = movesBy.get(m.shipmentId) ?? { eta: [], etd: [] };
    (m.kind === 'eta_changed' ? entry.eta : entry.etd).push({ reportDate: m.reportDate, from: m.from, to: m.to });
    movesBy.set(m.shipmentId, entry);
  }
  const inputs: SupplierLineInput[] = rows.map((r) => ({
    ...r,
    firstReportDate: r.firstReportDate ?? first?.reportDate ?? '9999-12-31',
    etaMoves: movesBy.get(r.id)?.eta ?? [],
    etdMoves: movesBy.get(r.id)?.etd ?? [],
  }));
  const received = receivedDates(inputs, lots);
  return { lines: inputs.map((l) => supplierLine(l, received.get(l.id) ?? null)), firstUpload: first?.reportDate ?? null };
}

export async function supplierPerformance(db: Db, opts: { branch?: string; period: number; includeHistory: boolean; today: string }): Promise<SupplierPerformanceResponse> {
  const { lines, firstUpload } = await loadSupplierLines(db, opts.branch);
  const from = addDays(opts.today, -(opts.period - 1));
  const prevFrom = addDays(from, -opts.period);
  const prevTo = addDays(from, -1);
  const score = { from, to: opts.today, today: opts.today, includeHistory: opts.includeHistory };
  const scores = scoreSuppliers(lines, score);
  const counted = (b: SupplierLine['arrivalBaseline']) => b === 'first' || (opts.includeHistory && b === 'final');
  const arrivals = (a: string, b: string, include = opts.includeHistory) =>
    lines.filter((l) => l.arrived && l.arrived >= a && l.arrived <= b && (l.arrivalBaseline === 'first' || (include && l.arrivalBaseline === 'final')));
  return {
    from,
    to: opts.today,
    period: opts.period,
    includeHistory: opts.includeHistory,
    firstUpload,
    totals: {
      arrival: onTime(arrivals(from, opts.today).map((l) => l.arrivalDaysLate!)),
      previousArrival: onTime(arrivals(prevFrom, prevTo).map((l) => l.arrivalDaysLate!)),
      ship: onTime(lines.filter((l) => l.shipped && l.shipped >= from && l.shipped <= opts.today && counted(l.shipBaseline)).map((l) => l.shipDaysLate!)),
      historyArrivals: arrivals(from, opts.today, true).length - arrivals(from, opts.today, false).length,
      suppliers: scores.length,
      consistentlyLate: scores.filter((s) => s.status === 'consistently_late').length,
      gettingWorse: scores.filter((s) => s.status === 'getting_worse').length,
      etaMoves: lines.reduce((n, l) => n + l.etaMoves, 0),
    },
    trend: supplierTrend(lines, opts.today, opts.includeHistory),
    suppliers: scores,
  };
}

export async function supplierDetail(db: Db, supplier: string, opts: { branch?: string; includeHistory: boolean; today: string }): Promise<SupplierDetailResponse> {
  const { lines } = await loadSupplierLines(db, opts.branch);
  const mine = lines.filter((l) => l.supplier === supplier);
  const late = (l: SupplierLine) => Math.max(l.arrivalDaysLate ?? -Infinity, l.shipDaysLate ?? -Infinity);
  return {
    supplier,
    trend: supplierTrend(mine, opts.today, opts.includeHistory),
    lines: mine.sort((a, b) => late(b) - late(a) || (b.arrived ?? b.finalEta ?? '').localeCompare(a.arrived ?? a.finalEta ?? '')).slice(0, 300),
  };
}

/** What each ODM Open Order report said about each order (EMS PO# + CPN). */
async function ordersSeen(db: Db): Promise<OrderSeen[]> {
  const rows = await db
    .select({
      emsPo: outboundOrders.emsPo,
      cpn: outboundOrders.cpn,
      reportDate: outboundSnapshots.reportDate,
      confirmedShipDate: sql<string | null>`min(${outboundOrders.confirmedShipDate})::text`,
      dockDate: sql<string | null>`min(${outboundOrders.dockDate})::text`,
    })
    .from(outboundOrders)
    .innerJoin(outboundSnapshots, eq(outboundSnapshots.id, outboundOrders.snapshotId))
    .where(and(isNotNull(outboundSnapshots.completedAt), isNotNull(outboundOrders.emsPo), isNotNull(outboundOrders.cpn)))
    .groupBy(outboundOrders.emsPo, outboundOrders.cpn, outboundSnapshots.reportDate);
  return rows as OrderSeen[];
}

const soBranch = (branch: string | undefined) =>
  !branch ? undefined : branch === NO_BRANCH ? isNull(soShipments.branch) : eq(soShipments.branch, branch);

export async function shippingPerformance(db: Db, opts: { branch?: string; period: number; today: string }): Promise<ShippingPerformanceResponse> {
  const months = lastMonths(opts.today, 24);
  const trendFrom = `${months[0]}-01`;
  const [rows, seen, [firstOrders]] = await Promise.all([
    db
      .select({
        id: soShipments.id,
        shipTo: soShipments.shipTo,
        odmPo: soShipments.odmPo,
        partNumber: soShipments.partNumber,
        branch: soShipments.branch,
        quantity: soShipments.quantity,
        shipDate: soShipments.shipDate,
        soEtd: soShipments.soEtd,
      })
      .from(soShipments)
      .where(and(gte(soShipments.shipDate, trendFrom), soBranch(opts.branch))),
    ordersSeen(db),
    db.select({ reportDate: sql<string | null>`min(${outboundSnapshots.reportDate})::text` }).from(outboundSnapshots).where(isNotNull(outboundSnapshots.completedAt)),
  ]);
  const lines = matchShipments(rows, seen);
  const from = addDays(opts.today, -(opts.period - 1));
  const prevFrom = addDays(from, -opts.period);
  const inPeriod = lines.filter((l) => l.shipDate >= from && l.shipDate <= opts.today);
  const late = inPeriod
    .filter((l) => (l.vsConfirmed ?? l.vsEtd ?? 0) > 0)
    .sort((a, b) => b.shipDate.localeCompare(a.shipDate) || (b.vsConfirmed ?? b.vsEtd ?? 0) - (a.vsConfirmed ?? a.vsEtd ?? 0))
    .slice(0, 200);
  return {
    from,
    to: opts.today,
    period: opts.period,
    firstOrderReport: firstOrders?.reportDate ?? null,
    shipments: inPeriod.length,
    matched: inPeriod.filter((l) => l.firstConfirmed || l.firstRequest).length,
    totals: shipOnTime(inPeriod),
    previous: shipOnTime(lines.filter((l) => l.shipDate >= prevFrom && l.shipDate < from)),
    trend: shipTrend(lines, months),
    byShipTo: shipGroups(inPeriod, (l) => l.shipTo ?? 'Unknown'),
    byBranch: shipGroups(inPeriod, (l) => l.branch ?? 'Unknown'),
    late,
  };
}

export async function receivingPerformance(db: Db, opts: { branch?: string; today: string }): Promise<ReceivingResponse> {
  const months = lastMonths(opts.today, 12);
  const etaSql = sql`${poLineVersions.data}->>'promisedArrivalDate'`;
  const branchSql = sql<string | null>`${poLineVersions.data}->>'branch'`;
  const [pastDue, current, shipped, [kept]] = await Promise.all([
    db
      .select({
        reportDate: sql<string>`${imports.reportDate}::text`,
        branch: branchSql,
        daysPastDue: sql<number>`(${imports.reportDate} - (${etaSql})::date)::int`,
        quantity: sql<number | null>`(${poLineVersions.data}->>'quantity')::numeric`.mapWith(Number),
      })
      .from(poReportLines)
      .innerJoin(poLineVersions, eq(poLineVersions.id, poReportLines.versionId))
      .innerJoin(imports, eq(imports.id, poReportLines.importId))
      .where(
        and(
          activeImport,
          sql`${poLineVersions.data}->>'poStatus' = 'open'`,
          sql`coalesce(${poLineVersions.data}->>'actualArrivalDate', '') = ''`,
          sql`(${etaSql}) < ${imports.reportDate}::text`,
          opts.branch ? (opts.branch === NO_BRANCH ? sql`${branchSql} is null` : sql`${branchSql} = ${opts.branch}`) : undefined,
        ),
      ),
    db
      .select({
        id: shipments.id,
        supplier: suppliers.name,
        poNumber: shipments.poNumber,
        lineRef: shipments.lineRef,
        partNumber: shipments.partNumber,
        branch: shipments.branch,
        quantity: shipments.quantity,
        eta: sql<string>`coalesce(${shipments.estimatedArrivalDate}, ${shipments.promisedArrivalDate})::text`,
        status: shipments.status,
      })
      .from(shipments)
      .innerJoin(suppliers, eq(suppliers.id, shipments.supplierId))
      .where(
        and(
          isNull(shipments.actualArrivalDate),
          or(isNull(shipments.poStatus), ne(shipments.poStatus, 'closed')),
          lt(sql`coalesce(${shipments.estimatedArrivalDate}, ${shipments.promisedArrivalDate})`, opts.today),
          branchFilter(opts.branch),
        ),
      )
      .orderBy(asc(sql`coalesce(${shipments.estimatedArrivalDate}, ${shipments.promisedArrivalDate})`)),
    db
      .select({ branch: soShipments.branch, receiptDate: soShipments.receiptDate, shipDate: soShipments.shipDate })
      .from(soShipments)
      .where(and(gte(soShipments.shipDate, `${months[0]}-01`), soBranch(opts.branch))),
    db.select({ n: sql<number>`count(*)::int` }).from(imports).where(and(activeImport, eq(imports.linesStored, true))),
  ]);
  const rows = pastDue as PastDueRow[];
  const branches = [...new Set(rows.map((r) => r.branch ?? 'Unknown'))].sort();
  const latestDate = rows.reduce<string | null>((d, r) => (!d || r.reportDate > d ? r.reportDate : d), null);
  return {
    reports: kept?.n ?? 0,
    pastDue: pastDueTrend(rows),
    byBranch: branches.map((b) => {
      const trend = pastDueTrend(rows.map((r) => ({ ...r, branch: r.branch ?? 'Unknown' })), b);
      return { branch: b, latest: trend.find((p) => p.reportDate === latestDate) ?? null, trend };
    }),
    current: current.map((c) => ({ ...c, daysPastDue: daysBetween(c.eta, opts.today) })),
    receiptToShip: receiptToShip(shipped, months),
  };
}
