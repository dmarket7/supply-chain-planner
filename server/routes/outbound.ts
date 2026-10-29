import { Hono } from 'hono';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { summarizeLines, type OrderRowForDiff } from '../../shared/orderChanges';
import { orderNoteSchema, outboundOrdersChunkSchema, startOutboundSchema, type OrderHistoryResponse } from '../../shared/types';
import { getDb } from '../db/client';
import { orderChangeNotes, outboundChanges, outboundOrders, outboundSnapshots } from '../db/schema';
import type { AppEnv } from '../env';
import { recomputeChanges, snapshotInfo, supersededBy } from '../outbound';

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
    await recomputeChanges(db, snap);
  }
  return c.json(await snapshotInfo(db, snap));
});

const sameCpn = <T extends typeof outboundOrders.cpn | typeof outboundChanges.cpn | typeof orderChangeNotes.cpn>(col: T, cpn: string | null) =>
  cpn === null ? isNull(col) : eq(col, cpn);

/** One SO# + CPN across every kept report: its dates, quantity and reservation, what changed, and the team's notes. */
outboundRoutes.get('/history', async (c) => {
  const so = c.req.query('so');
  if (!so) return c.json({ error: 'so is required' }, 400);
  const cpn = c.req.query('cpn') || null;
  const db = getDb(c.env.DATABASE_URL);
  const [snaps, rows, changes, notes] = await Promise.all([
    db
      .select({ id: outboundSnapshots.id, reportDate: outboundSnapshots.reportDate })
      .from(outboundSnapshots)
      .where(isNotNull(outboundSnapshots.completedAt))
      .orderBy(asc(outboundSnapshots.reportDate)),
    db
      .select({
        snapshotId: outboundOrders.snapshotId,
        soNumber: outboundOrders.soNumber,
        cpn: outboundOrders.cpn,
        shipTo: outboundOrders.shipTo,
        warehouse: outboundOrders.warehouse,
        status: outboundOrders.status,
        quantity: outboundOrders.quantity,
        confirmedShipDate: outboundOrders.confirmedShipDate,
        dockDate: outboundOrders.dockDate,
        scheduledShipDate: outboundOrders.scheduledShipDate,
      })
      .from(outboundOrders)
      .where(and(eq(outboundOrders.soNumber, so), sameCpn(outboundOrders.cpn, cpn))),
    db
      .select()
      .from(outboundChanges)
      .where(and(eq(outboundChanges.soNumber, so), sameCpn(outboundChanges.cpn, cpn)))
      .orderBy(asc(outboundChanges.reportDate), asc(outboundChanges.id)),
    db
      .select()
      .from(orderChangeNotes)
      .where(and(eq(orderChangeNotes.soNumber, so), sameCpn(orderChangeNotes.cpn, cpn)))
      .orderBy(asc(orderChangeNotes.createdAt)),
  ]);
  const userId = c.get('userId');
  const body: OrderHistoryResponse = {
    soNumber: so,
    cpn,
    reports: snaps.map((s) => ({
      reportDate: s.reportDate,
      line: [...summarizeLines(rows.filter((r) => r.snapshotId === s.id) as OrderRowForDiff[]).values()][0] ?? null,
    })),
    changes: changes.map((ch) => ({
      reportDate: ch.reportDate,
      previousReportDate: ch.previousReportDate,
      kind: ch.kind,
      from: ch.fromValue,
      to: ch.toValue,
      causes: ch.causes,
    })),
    notes: notes.map((n) => ({
      id: n.id,
      reportDate: n.reportDate,
      kind: n.kind,
      note: n.note,
      author: n.createdByLabel ?? n.createdBy,
      createdAt: n.createdAt.toISOString(),
      mine: n.createdBy === userId,
    })),
  };
  return c.json(body);
});

/** A note on why an order line changed. */
outboundRoutes.post('/notes', async (c) => {
  const parsed = orderNoteSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid note', issues: parsed.error.issues }, 400);
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .insert(orderChangeNotes)
    .values({ ...parsed.data, createdBy: c.get('userId'), createdByLabel: c.get('userLabel') })
    .returning({ id: orderChangeNotes.id });
  return c.json({ id: row.id }, 201);
});

/** Only the author can remove a note. */
outboundRoutes.delete('/notes/:id', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const deleted = await db
    .delete(orderChangeNotes)
    .where(and(eq(orderChangeNotes.id, Number(c.req.param('id'))), eq(orderChangeNotes.createdBy, c.get('userId'))))
    .returning({ id: orderChangeNotes.id });
  if (!deleted.length) return c.json({ error: 'Note not found' }, 404);
  return c.json({ ok: true });
});
