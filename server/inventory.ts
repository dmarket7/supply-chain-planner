import { and, desc, eq, isNotNull, or, sql } from 'drizzle-orm';
import type { InventorySnapshotInfo } from '../shared/types';
import type { Db } from './db/client';
import { inventorySnapshots } from './db/schema';

type Snapshot = typeof inventorySnapshots.$inferSelect;

/** The latest completed Inventory Summary by report date (a re-upload of the same date wins). */
export async function currentInventory(db: Db): Promise<Snapshot | undefined> {
  const [row] = await db
    .select()
    .from(inventorySnapshots)
    .where(isNotNull(inventorySnapshots.completedAt))
    .orderBy(desc(inventorySnapshots.reportDate), desc(inventorySnapshots.id))
    .limit(1);
  return row;
}

export function inventoryInfo(s: Snapshot): InventorySnapshotInfo {
  return { id: s.id, fileName: s.fileName, reportDate: s.reportDate, rowCount: s.rowCount, positionCount: s.positionCount };
}

/** Uploads of the same report date replaced by this one, and abandoned uploads. */
export function inventorySupersededBy(s: Snapshot) {
  return and(
    sql`${inventorySnapshots.id} <> ${s.id}`,
    or(eq(inventorySnapshots.reportDate, s.reportDate), sql`${inventorySnapshots.completedAt} is null and ${inventorySnapshots.id} < ${s.id}`),
  );
}
