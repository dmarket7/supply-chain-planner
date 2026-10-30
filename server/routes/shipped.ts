import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { shippedChunkSchema } from '../../shared/types';
import { getDb } from '../db/client';
import { soShipments } from '../db/schema';
import type { AppEnv } from '../env';

export const shippedRoutes = new Hono<AppEnv>();

/**
 * Shipped sales order lines from the Transactions tab. Each report lists past shipments again, so
 * rows are upserted by key and remember the first report that listed them.
 */
shippedRoutes.post('/rows', async (c) => {
  const parsed = shippedChunkSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid shipments', issues: parsed.error.issues.slice(0, 10) }, 400);
  const { reportDate, rows } = parsed.data;
  const db = getDb(c.env.DATABASE_URL);
  await db
    .insert(soShipments)
    .values(rows.map((r) => ({ ...r, firstReportDate: reportDate })))
    .onConflictDoUpdate({
      target: soShipments.dedupeKey,
      set: {
        shipTo: sql`excluded.ship_to`,
        branch: sql`excluded.branch`,
        quantity: sql`excluded.quantity`,
        soEtd: sql`excluded.so_etd`,
        soEta: sql`excluded.so_eta`,
        receiptDate: sql`excluded.receipt_date`,
        tracking: sql`excluded.tracking`,
        firstReportDate: sql`least(excluded.first_report_date, ${soShipments.firstReportDate})`,
      },
    });
  return c.json({ ok: true });
});
