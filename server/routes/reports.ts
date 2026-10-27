import { Hono } from 'hono';
import { and, asc, eq, getTableColumns, gte, isNull, lte, sql } from 'drizzle-orm';
import { addDays, todayIso } from '../../shared/dates';
import type { ArrivalsResponse, InboundResponse, OutboundOrderInput, OutboundResponse, Shipment } from '../../shared/types';
import { getDb } from '../db/client';
import { outboundOrders, palletRatios, promisedDateHistory, shipments, suppliers } from '../db/schema';
import type { AppEnv } from '../env';
import { currentSnapshot, snapshotInfo } from '../outbound';
import { loadRatioLookup } from '../palletRatios';
import { groupInboundByDay, groupInboundByPart, outboundReport, supplierScorecard, toArrivalEntry, withPallets } from '../reports';
import { branchFilter, NO_BRANCH, shipmentColumns } from './common';

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

/** Open sales orders from the current ODM Open Order snapshot, in pallets and trucks. */
reportsRoutes.get('/outbound', async (c) => {
  const today = todayIso();
  const from = c.req.query('from') ?? addDays(today, -7);
  const to = c.req.query('to') ?? addDays(today, 28);
  const branch = c.req.query('branch');
  const db = getDb(c.env.DATABASE_URL);
  const snap = await currentSnapshot(db);
  if (!snap) {
    const body: OutboundResponse = { from, to, snapshot: null, ...outboundReport([], from, to, today) };
    return c.json(body);
  }
  const { snapshotId: _s, ...orderColumns } = getTableColumns(outboundOrders);
  const [rows, ratios, info] = await Promise.all([
    db
      .select({ ...orderColumns, itemName: palletRatios.itemName })
      .from(outboundOrders)
      .leftJoin(palletRatios, eq(palletRatios.partNumber, outboundOrders.cpn))
      .where(
        and(
          eq(outboundOrders.snapshotId, snap.id),
          !branch ? undefined : branch === NO_BRANCH ? isNull(outboundOrders.warehouse) : eq(outboundOrders.warehouse, branch),
        ),
      ),
    loadRatioLookup(db),
    snapshotInfo(db, snap),
  ]);
  const orders = rows.map((o) => ({
    ...(o as OutboundOrderInput & { id: number; itemName: string | null }),
    pallets: ratios.line(o.cpn, o.businessGroup, o.quantity),
  }));
  const body: OutboundResponse = { from, to, snapshot: info, ...outboundReport(orders, from, to, today) };
  return c.json(body);
});
