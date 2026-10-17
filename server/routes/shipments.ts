import { Hono } from 'hono';
import { and, asc, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { SHIPMENT_STATUSES, type ShipmentDetail } from '../../shared/types';
import { getDb } from '../db/client';
import { promisedDateHistory, shipments, suppliers, trackingEvents } from '../db/schema';
import type { AppEnv } from '../env';
import { shipmentColumns } from './common';

export const shipmentsRoutes = new Hono<AppEnv>();

const expectedDate = sql`coalesce(${shipments.estimatedArrivalDate}, ${shipments.promisedArrivalDate})`;

shipmentsRoutes.get('/', async (c) => {
  const { status, carrier, supplier, from, to, q } = c.req.query();
  const filters: SQL[] = [];
  if (status && (SHIPMENT_STATUSES as readonly string[]).includes(status)) {
    filters.push(eq(shipments.status, status as (typeof SHIPMENT_STATUSES)[number]));
  }
  if (carrier) filters.push(eq(shipments.carrier, carrier));
  if (supplier) filters.push(eq(suppliers.name, supplier));
  if (from) filters.push(gte(expectedDate, from));
  if (to) filters.push(lte(expectedDate, to));
  if (q) {
    const like = `%${q}%`;
    filters.push(or(ilike(shipments.trackingNumber, like), ilike(shipments.poNumber, like), ilike(suppliers.name, like))!);
  }

  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select(shipmentColumns)
    .from(shipments)
    .innerJoin(suppliers, eq(suppliers.id, shipments.supplierId))
    .where(and(...filters))
    .orderBy(asc(expectedDate), asc(shipments.id))
    .limit(2000);
  return c.json(rows);
});

shipmentsRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const db = getDb(c.env.DATABASE_URL);
  const [shipment] = await db
    .select(shipmentColumns)
    .from(shipments)
    .innerJoin(suppliers, eq(suppliers.id, shipments.supplierId))
    .where(eq(shipments.id, id));
  if (!shipment) return c.json({ error: 'Not found' }, 404);

  const [events, history] = await Promise.all([
    db
      .select({
        id: trackingEvents.id,
        occurredAt: trackingEvents.occurredAt,
        status: trackingEvents.status,
        description: trackingEvents.description,
        location: trackingEvents.location,
        provider: trackingEvents.provider,
      })
      .from(trackingEvents)
      .where(eq(trackingEvents.shipmentId, id))
      .orderBy(desc(trackingEvents.occurredAt)),
    db
      .select({
        previousDate: promisedDateHistory.previousDate,
        newDate: promisedDateHistory.newDate,
        changedAt: promisedDateHistory.changedAt,
      })
      .from(promisedDateHistory)
      .where(eq(promisedDateHistory.shipmentId, id))
      .orderBy(asc(promisedDateHistory.changedAt)),
  ]);

  const detail = { ...shipment, events, promisedDateHistory: history };
  return c.json(detail as unknown as ShipmentDetail);
});

const arrivalSchema = z.object({
  actualArrivalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

/** Mark a shipment arrived (or clear the arrival with `null`). */
shipmentsRoutes.patch('/:id/arrival', async (c) => {
  const parsed = arrivalSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid date' }, 400);
  const { actualArrivalDate } = parsed.data;
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .update(shipments)
    .set({
      actualArrivalDate,
      arrivalSource: actualArrivalDate ? 'manual' : null,
      status: actualArrivalDate ? 'delivered' : 'pending',
      updatedAt: new Date(),
    })
    .where(eq(shipments.id, Number(c.req.param('id'))))
    .returning({ id: shipments.id });
  return row ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
});
