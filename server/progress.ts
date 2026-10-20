import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { ProgressCounts } from '../shared/progress';
import type { Db } from './db/client';
import { lineChanges, shipments } from './db/schema';

/**
 * Lines per progress bucket for one upload; the SQL twin of `bucketsOf` in shared/progress.ts.
 * Counting in Postgres keeps the Worker's CPU time flat even for a first upload of thousands of lines.
 */
export async function progressCounts(db: Db, importId: number, branchFilter?: SQL): Promise<ProgressCounts> {
  const [row] = await progressCountsQuery(db, importId, branchFilter);
  return row;
}

export function progressCountsQuery(db: Db, importId: number, branchFilter?: SQL) {
  const n = (cond: SQL) => sql<number>`count(distinct ${lineChanges.shipmentId}) filter (where ${cond})::int`;
  const kind = lineChanges.kind;
  const to = lineChanges.toValue;
  return db
    .select({
      shipped: n(sql`${kind} = 'shipped' or (${kind} = 'new' and ${to} = 'in_transit')`),
      arrived: n(sql`${kind} = 'closed' or (${kind} = 'new' and ${to} = 'delivered')`),
      eta_moved: n(sql`${kind} = 'eta_changed'`),
      tracking: n(sql`${kind} in ('tracking_added', 'tracking_changed')`),
      new_order: n(sql`${kind} = 'new' and ${to} in ('awaiting_shipment', 'pending')`),
      reopened: n(sql`${kind} = 'reopened'`),
    })
    .from(lineChanges)
    .innerJoin(shipments, eq(shipments.id, lineChanges.shipmentId))
    .where(and(eq(lineChanges.importId, importId), branchFilter));
}
