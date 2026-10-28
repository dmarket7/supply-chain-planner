import { and, asc, desc, eq, gt, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import { diffOrders, etaMoveKey, summarizeChanges, type OrderChangeSummary, type OrderRowForDiff } from '../shared/orderChanges';
import type { OutboundChanges, OutboundSnapshotInfo } from '../shared/types';
import type { Db } from './db/client';
import { lineChanges, outboundChanges, outboundOrders, outboundSnapshots, shipments } from './db/schema';
import { chunk } from './routes/common';

type Snapshot = typeof outboundSnapshots.$inferSelect;

const newestFirst = [desc(outboundSnapshots.reportDate), desc(outboundSnapshots.id)];

/** The latest completed snapshot by report date (a re-upload of the same date wins). */
export async function currentSnapshot(db: Db): Promise<Snapshot | undefined> {
  const [row] = await db.select().from(outboundSnapshots).where(isNotNull(outboundSnapshots.completedAt)).orderBy(...newestFirst).limit(1);
  return row;
}

export async function previousSnapshot(db: Db, s: Snapshot): Promise<Snapshot | undefined> {
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
    summary: await changeSummary(db, s.id),
  };
}

export async function changeSummary(db: Db, snapshotId: number): Promise<OrderChangeSummary> {
  const rows = await db
    .select({ kind: outboundChanges.kind, from: outboundChanges.fromValue, to: outboundChanges.toValue, causes: outboundChanges.causes })
    .from(outboundChanges)
    .where(eq(outboundChanges.snapshotId, snapshotId));
  return summarizeChanges(rows);
}

const diffColumns = {
  soNumber: outboundOrders.soNumber,
  cpn: outboundOrders.cpn,
  shipTo: outboundOrders.shipTo,
  warehouse: outboundOrders.warehouse,
  status: outboundOrders.status,
  quantity: outboundOrders.quantity,
  confirmedShipDate: outboundOrders.confirmedShipDate,
  dockDate: outboundOrders.dockDate,
  scheduledShipDate: outboundOrders.scheduledShipDate,
};

/** Parts and sites whose inbound PO lines changed ETA in the reports after `from`, up to `to`. */
async function etaMoves(db: Db, from: string, to: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ partNumber: shipments.partNumber, branch: shipments.branch })
    .from(lineChanges)
    .innerJoin(shipments, eq(shipments.id, lineChanges.shipmentId))
    .where(and(eq(lineChanges.kind, 'eta_changed'), gt(lineChanges.reportDate, from), lte(lineChanges.reportDate, to)));
  return new Set(rows.map((r) => etaMoveKey(r.partNumber, r.branch)));
}

/** Stores what changed in `s` since the previous snapshot, replacing what was stored before. */
async function computeChanges(db: Db, s: Snapshot): Promise<void> {
  await db.delete(outboundChanges).where(eq(outboundChanges.snapshotId, s.id));
  const prev = await previousSnapshot(db, s);
  if (!prev) return;
  const [before, now, moves] = await Promise.all([
    db.select(diffColumns).from(outboundOrders).where(eq(outboundOrders.snapshotId, prev.id)),
    db.select(diffColumns).from(outboundOrders).where(eq(outboundOrders.snapshotId, s.id)),
    etaMoves(db, prev.reportDate, s.reportDate),
  ]);
  const changes = diffOrders(before as OrderRowForDiff[], now as OrderRowForDiff[], moves);
  for (const part of chunk(changes, 500)) {
    await db.insert(outboundChanges).values(
      part.map((c) => ({
        snapshotId: s.id,
        reportDate: s.reportDate,
        previousReportDate: prev.reportDate,
        soNumber: c.soNumber,
        cpn: c.cpn,
        shipTo: c.shipTo,
        warehouse: c.warehouse,
        kind: c.kind,
        fromValue: c.from,
        toValue: c.to,
        causes: c.causes,
      })),
    );
  }
}

/** After deleting a report date: the next newer snapshot now compares with an earlier one. */
export async function recomputeChangesAfter(db: Db, reportDate: string): Promise<void> {
  const [next] = await db
    .select()
    .from(outboundSnapshots)
    .where(and(isNotNull(outboundSnapshots.completedAt), gt(outboundSnapshots.reportDate, reportDate)))
    .orderBy(asc(outboundSnapshots.reportDate), desc(outboundSnapshots.id))
    .limit(1);
  if (next) await computeChanges(db, next);
}

/**
 * Recomputes the changes of a just-completed snapshot and of the next newer one, whose "previous"
 * may now be this one (an older report imported late).
 */
export async function recomputeChanges(db: Db, s: Snapshot): Promise<void> {
  await computeChanges(db, s);
  await recomputeChangesAfter(db, s.reportDate);
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
