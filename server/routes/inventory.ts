import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { inventoryPositionsChunkSchema, receiptsChunkSchema, startInventorySchema } from '../../shared/types';
import { getDb } from '../db/client';
import { inventoryPositions, inventorySnapshots, poReceipts } from '../db/schema';
import type { AppEnv } from '../env';
import { inventoryInfo, inventorySupersededBy } from '../inventory';

export const inventoryRoutes = new Hono<AppEnv>();

/** Step 1: start a snapshot of the Inventory Summary tab; it replaces stock as of its report date. */
inventoryRoutes.post('/snapshots', async (c) => {
  const parsed = startInventorySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid inventory import', issues: parsed.error.issues }, 400);
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .insert(inventorySnapshots)
    .values({ ...parsed.data, uploadedBy: c.get('userId') })
    .returning({ id: inventorySnapshots.id });
  return c.json({ snapshotId: row.id }, 201);
});

/** Step 2: one chunk of positions (≤ INVENTORY_CHUNK_SIZE). */
inventoryRoutes.post('/snapshots/:id/positions', async (c) => {
  const snapshotId = Number(c.req.param('id'));
  const parsed = inventoryPositionsChunkSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid inventory positions', issues: parsed.error.issues.slice(0, 10) }, 400);
  const db = getDb(c.env.DATABASE_URL);
  const [snap] = await db.select().from(inventorySnapshots).where(eq(inventorySnapshots.id, snapshotId));
  if (!snap) return c.json({ error: 'Inventory import not found' }, 404);
  if (snap.completedAt) return c.json({ error: 'Inventory import already completed' }, 409);
  await db.insert(inventoryPositions).values(parsed.data.positions.map((p) => ({ ...p, snapshotId })));
  return c.json({ ok: true });
});

/** Step 3: make the snapshot current and drop the uploads it replaces. */
inventoryRoutes.post('/snapshots/:id/complete', async (c) => {
  const snapshotId = Number(c.req.param('id'));
  const db = getDb(c.env.DATABASE_URL);
  let [snap] = await db.select().from(inventorySnapshots).where(eq(inventorySnapshots.id, snapshotId));
  if (!snap) return c.json({ error: 'Inventory import not found' }, 404);
  if (!snap.completedAt) {
    [snap] = await db.update(inventorySnapshots).set({ completedAt: new Date() }).where(eq(inventorySnapshots.id, snapshotId)).returning();
    await db.delete(inventorySnapshots).where(inventorySupersededBy(snap));
  }
  return c.json(inventoryInfo(snap));
});

/** Received lots (open and closed rows). Receipts are facts, so they're upserted and never removed. */
inventoryRoutes.post('/receipts', async (c) => {
  const parsed = receiptsChunkSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid receipts', issues: parsed.error.issues.slice(0, 10) }, 400);
  const { reportDate, receipts } = parsed.data;
  const db = getDb(c.env.DATABASE_URL);
  await db
    .insert(poReceipts)
    .values(receipts.map((r) => ({ ...r, lastReportDate: reportDate })))
    .onConflictDoUpdate({
      target: [poReceipts.poNumber, poReceipts.poLine, poReceipts.branch, poReceipts.receiptDate],
      set: {
        partNumber: sql`coalesce(excluded.part_number, ${poReceipts.partNumber})`,
        arrivedDate: sql`coalesce(excluded.arrived_date, ${poReceipts.arrivedDate})`,
        quantity: sql`excluded.quantity`,
        lastReportDate: sql`greatest(excluded.last_report_date, ${poReceipts.lastReportDate})`,
      },
    });
  return c.json({ ok: true });
});
