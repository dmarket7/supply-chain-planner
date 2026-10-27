import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { outboundOrdersChunkSchema, startOutboundSchema } from '../../shared/types';
import { getDb } from '../db/client';
import { outboundOrders, outboundSnapshots } from '../db/schema';
import type { AppEnv } from '../env';
import { snapshotInfo, supersededBy } from '../outbound';

export const outboundRoutes = new Hono<AppEnv>();

/**
 * Step 1: start a snapshot of the ODM Open Order tab. Each upload replaces the open-order list as of
 * its report date; older snapshots are kept to show what changed between reports.
 */
outboundRoutes.post('/snapshots', async (c) => {
  const parsed = startOutboundSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid outbound import', issues: parsed.error.issues }, 400);
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .insert(outboundSnapshots)
    .values({ ...parsed.data, uploadedBy: c.get('userId') })
    .returning({ id: outboundSnapshots.id });
  return c.json({ snapshotId: row.id }, 201);
});

/** Step 2: one chunk of orders (≤ OUTBOUND_CHUNK_SIZE). */
outboundRoutes.post('/snapshots/:id/orders', async (c) => {
  const snapshotId = Number(c.req.param('id'));
  const parsed = outboundOrdersChunkSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid orders', issues: parsed.error.issues.slice(0, 10) }, 400);
  const db = getDb(c.env.DATABASE_URL);
  const [snap] = await db.select().from(outboundSnapshots).where(eq(outboundSnapshots.id, snapshotId));
  if (!snap) return c.json({ error: 'Outbound import not found' }, 404);
  if (snap.completedAt) return c.json({ error: 'Outbound import already completed' }, 409);
  await db.insert(outboundOrders).values(parsed.data.orders.map((o) => ({ ...o, snapshotId })));
  return c.json({ ok: true });
});

/** Step 3: make the snapshot current, drop the uploads it replaces, and report what changed. */
outboundRoutes.post('/snapshots/:id/complete', async (c) => {
  const snapshotId = Number(c.req.param('id'));
  const db = getDb(c.env.DATABASE_URL);
  let [snap] = await db.select().from(outboundSnapshots).where(eq(outboundSnapshots.id, snapshotId));
  if (!snap) return c.json({ error: 'Outbound import not found' }, 404);
  if (!snap.completedAt) {
    [snap] = await db.update(outboundSnapshots).set({ completedAt: new Date() }).where(eq(outboundSnapshots.id, snapshotId)).returning();
    await db.delete(outboundSnapshots).where(supersededBy(snap));
  }
  return c.json(await snapshotInfo(db, snap));
});
