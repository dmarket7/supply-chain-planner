import { Hono } from 'hono';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { addDays, todayIso } from '../../shared/dates';
import type { ArrivalsResponse, Shipment } from '../../shared/types';
import { getDb } from '../db/client';
import { promisedDateHistory, shipments, suppliers } from '../db/schema';
import type { AppEnv } from '../env';
import { groupInboundByDay, supplierScorecard, toArrivalEntry } from '../reports';
import { branchFilter, shipmentColumns } from './common';

export const reportsRoutes = new Hono<AppEnv>();

const expectedDate = sql<string>`coalesce(${shipments.estimatedArrivalDate}, ${shipments.promisedArrivalDate})`;

reportsRoutes.get('/inbound-by-day', async (c) => {
  const from = c.req.query('from') ?? addDays(todayIso(), -7);
  const to = c.req.query('to') ?? addDays(todayIso(), 21);
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select(shipmentColumns)
    .from(shipments)
    .innerJoin(suppliers, eq(suppliers.id, shipments.supplierId))
    .where(and(gte(expectedDate, from), lte(expectedDate, to), branchFilter(c.req.query('branch'))))
    .orderBy(asc(expectedDate));
  return c.json({ from, to, days: groupInboundByDay(rows as Shipment[]) });
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
