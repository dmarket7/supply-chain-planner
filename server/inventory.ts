import { and, desc, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { isHeldBranch, siteOf } from '../shared/supply';
import type { InventorySnapshotInfo } from '../shared/types';
import type { Db } from './db/client';
import { inventoryPositions, inventorySnapshots } from './db/schema';

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

export async function previousInventory(db: Db, s: Snapshot): Promise<Snapshot | undefined> {
  const [row] = await db
    .select()
    .from(inventorySnapshots)
    .where(and(isNotNull(inventorySnapshots.completedAt), lt(inventorySnapshots.reportDate, s.reportDate)))
    .orderBy(desc(inventorySnapshots.reportDate), desc(inventorySnapshots.id))
    .limit(1);
  return row;
}

/** Same key as the supply check's part rows. */
export const partSiteKey = (partNumber: string, site: string) => `${partNumber}\u0000${site}`;

/** Available stock per part and site, held branches left out, as the supply check counts it. */
export function availableBySite(positions: { partNumber: string; branch: string; available: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of positions) {
    if (isHeldBranch(p.branch)) continue;
    const key = partSiteKey(p.partNumber, siteOf(p.branch));
    out.set(key, (out.get(key) ?? 0) + p.available);
  }
  return out;
}

/** Available per part and site in the inventory reported before `s`; null when `s` is the first. */
export async function previousAvailable(db: Db, s: Snapshot): Promise<Map<string, number> | null> {
  const prev = await previousInventory(db, s);
  if (!prev) return null;
  const rows = await db
    .select({ partNumber: inventoryPositions.partNumber, branch: inventoryPositions.branch, available: inventoryPositions.available })
    .from(inventoryPositions)
    .where(eq(inventoryPositions.snapshotId, prev.id));
  return availableBySite(rows);
}
