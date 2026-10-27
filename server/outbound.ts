import { and, desc, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { OutboundChanges, OutboundSnapshotInfo } from '../shared/types';
import type { Db } from './db/client';
import { outboundOrders, outboundSnapshots } from './db/schema';

type Snapshot = typeof outboundSnapshots.$inferSelect;

const newestFirst = [desc(outboundSnapshots.reportDate), desc(outboundSnapshots.id)];

/** The latest completed snapshot by report date (a re-upload of the same date wins). */
export async function currentSnapshot(db: Db): Promise<Snapshot | undefined> {
  const [row] = await db.select().from(outboundSnapshots).where(isNotNull(outboundSnapshots.completedAt)).orderBy(...newestFirst).limit(1);
  return row;
}

async function previousSnapshot(db: Db, s: Snapshot): Promise<Snapshot | undefined> {
  const [row] = await db
    .select()
    .from(outboundSnapshots)
    .where(and(isNotNull(outboundSnapshots.completedAt), lt(outboundSnapshots.reportDate, s.reportDate)))
    .orderBy(...newestFirst)
    .limit(1);
  return row;
}

async function quantityBySo(db: Db, snapshotId: number): Promise<Map<string, number>> {
  const rows = await db
    .select({ so: outboundOrders.soNumber, qty: sql<number>`sum(${outboundOrders.quantity})`.mapWith(Number) })
    .from(outboundOrders)
    .where(eq(outboundOrders.snapshotId, snapshotId))
    .groupBy(outboundOrders.soNumber);
  return new Map(rows.map((r) => [r.so, r.qty]));
}

/** SOs gone (shipped or cancelled), new, and with a changed quantity since the previous report. */
export async function snapshotChanges(db: Db, s: Snapshot): Promise<OutboundChanges | null> {
  const prev = await previousSnapshot(db, s);
  if (!prev) return null;
  const [now, before] = await Promise.all([quantityBySo(db, s.id), quantityBySo(db, prev.id)]);
  let noLongerListed = 0;
  let quantityChanged = 0;
  for (const [so, qty] of before) {
    if (!now.has(so)) noLongerListed++;
    else if (now.get(so) !== qty) quantityChanged++;
  }
  return {
    previousReportDate: prev.reportDate,
    noLongerListed,
    added: [...now.keys()].filter((so) => !before.has(so)).length,
    quantityChanged,
  };
}

export async function snapshotInfo(db: Db, s: Snapshot): Promise<OutboundSnapshotInfo> {
  return {
    id: s.id,
    fileName: s.fileName,
    reportDate: s.reportDate,
    rowCount: s.rowCount,
    orderCount: s.orderCount,
    skippedQuotations: s.skippedQuotations,
    changes: await snapshotChanges(db, s),
  };
}

/** Uploads of the same report date replaced by this one, and abandoned uploads. */
export function supersededBy(s: Snapshot) {
  return and(
    sql`${outboundSnapshots.id} <> ${s.id}`,
    or(eq(outboundSnapshots.reportDate, s.reportDate), sql`${outboundSnapshots.completedAt} is null and ${outboundSnapshots.id} < ${s.id}`),
  );
}
