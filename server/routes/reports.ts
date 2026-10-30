import { Hono } from 'hono';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { addDays, todayIso } from '../../shared/dates';
import type { ArrivalsResponse, DashboardResponse, InboundResponse, OutboundResponse, Shipment, SupplyResponse } from '../../shared/types';
import { getDb } from '../db/client';
import { activeImport } from '../poHistory';
import { dashboard, supplyParts, withSupply } from '../dashboard';
import { imports, promisedDateHistory, shipments, suppliers } from '../db/schema';
import type { AppEnv } from '../env';
import { inventoryInfo, previousAvailable } from '../inventory';
import { snapshotInfo } from '../outbound';
import { loadRatioLookup } from '../palletRatios';
import { groupInboundByDay, groupInboundByPart, outboundReport, supplierScorecard, toArrivalEntry, withPallets } from '../reports';
import { supplierPerformance } from '../performance';
import { loadSupply } from '../supply';
import { branchFilter, shipmentColumns } from './common';

export const reportsRoutes = new Hono<AppEnv>();

const expectedDate = sql<string>`coalesce(${shipments.estimatedArrivalDate}, ${shipments.promisedArrivalDate})`;

reportsRoutes.get('/inbound-by-day', async (c) => {
  const from = c.req.query('from') ?? addDays(todayIso(), -7);
  const to = c.req.query('to') ?? addDays(todayIso(), 21);
  const db = getDb(c.env.DATABASE_URL);
  const [rows, ratios] = await Promise.all([
    db
      .select(shipmentColumns)
      .from(shipments)
      .innerJoin(suppliers, eq(suppliers.id, shipments.supplierId))
      .where(and(gte(expectedDate, from), lte(expectedDate, to), branchFilter(c.req.query('branch'))))
      .orderBy(asc(expectedDate)),
    loadRatioLookup(db),
  ]);
  const lines = withPallets(rows as Shipment[], ratios);
  const body: InboundResponse = { from, to, days: groupInboundByDay(lines), parts: groupInboundByPart(lines) };
  return c.json(body);
});

reportsRoutes.get('/arrivals', async (c) => {
  const from = c.req.query('from') ?? addDays(todayIso(), -90);
  const to = c.req.query('to') ?? todayIso();
  const supplier = c.req.query('supplier');
  const includeAssumed = c.req.query('includeAssumed') === '1';
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select({
      ...shipmentColumns,
      originalPromisedDate: sql<string | null>`coalesce(
        (select h.previous_date from ${promisedDateHistory} h
          where h.shipment_id = ${shipments.id} order by h.changed_at asc limit 1),
        ${shipments.promisedArrivalDate})`,
    })
    .from(shipments)
    .innerJoin(suppliers, eq(suppliers.id, shipments.supplierId))
    .where(
      and(
        gte(shipments.actualArrivalDate, from),
        lte(shipments.actualArrivalDate, to),
        supplier ? eq(suppliers.name, supplier) : undefined,
        branchFilter(c.req.query('branch')),
      ),
    )
    .orderBy(asc(shipments.actualArrivalDate));

  const entries = (rows as (Shipment & { originalPromisedDate: string | null })[])
    .filter((r): r is Shipment & { originalPromisedDate: string } => !!r.originalPromisedDate)
    .map(toArrivalEntry);
  const body: ArrivalsResponse = { entries, scorecard: supplierScorecard(entries, includeAssumed) };
  return c.json(body);
});

/** Open sales orders from the current ODM Open Order snapshot, in pallets and trucks, with whether they can ship. */
reportsRoutes.get('/outbound', async (c) => {
  const today = todayIso();
  const from = c.req.query('from') ?? addDays(today, -7);
  const to = c.req.query('to') ?? addDays(today, 28);
  const db = getDb(c.env.DATABASE_URL);
  const [supply, ratios] = await Promise.all([loadSupply(db, c.req.query('branch')), loadRatioLookup(db)]);
  const { outbound: snap, inventory } = supply;
  const orders = withSupply(supply, ratios);
  const body: OutboundResponse = {
    from,
    to,
    snapshot: snap ? await snapshotInfo(db, snap) : null,
    inventoryReportDate: inventory?.reportDate ?? null,
    ...outboundReport(orders, from, to, snap?.reportDate ?? today),
  };
  return c.json(body);
});

/** Stock and open demand per part and site, with each order's readiness and the inbound lines. */
reportsRoutes.get('/supply', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const supply = await loadSupply(db, c.req.query('branch'));
  const body: SupplyResponse = {
    inventory: supply.inventory ? inventoryInfo(supply.inventory) : null,
    outboundReportDate: supply.outbound?.reportDate ?? null,
    parts: supplyParts(supply, supply.inventory ? await previousAvailable(db, supply.inventory) : null),
  };
  return c.json(body);
});

/** The home dashboard: flow by week, and where things are stuck. */
reportsRoutes.get('/dashboard', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const branch = c.req.query('branch');
  const [supply, ratios, [lastImport]] = await Promise.all([
    loadSupply(db, branch),
    loadRatioLookup(db),
    db.select({ reportDate: imports.reportDate }).from(imports).where(activeImport).orderBy(desc(imports.reportDate)).limit(1),
  ]);
  const perf = await supplierPerformance(db, { branch, period: 90, includeHistory: false, today: todayIso() });
  const flagged = perf.suppliers.filter((s) => s.status === 'consistently_late' || s.status === 'getting_worse');
  const body: DashboardResponse = {
    ...dashboard(supply, ratios, lastImport?.reportDate ?? null, todayIso()),
    suppliers: {
      flagged: flagged.length,
      rows: flagged.slice(0, 5).map((s) => ({ supplier: s.supplier, status: s.status!, onTimePct: s.arrival.onTimePct, arrivals: s.arrival.count, medianDaysLate: s.arrival.medianDaysLate })),
    },
  };
  return c.json(body);
});
