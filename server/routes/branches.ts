import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { addDays, todayIso } from '../../shared/dates';
import type { BranchSummary } from '../../shared/types';
import { getDb } from '../db/client';
import { shipments } from '../db/schema';
import type { AppEnv } from '../env';
import { NO_BRANCH } from './common';

export const branchesRoutes = new Hono<AppEnv>();

/** Every branch with headline counts, for the branch selector and the per-branch summary. */
branchesRoutes.get('/', async (c) => {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('today') ?? '') ? c.req.query('today')! : todayIso();
  const weekAhead = addDays(today, 7);
  const monthAgo = addDays(today, -30);
  const expected = sql`coalesce(${shipments.estimatedArrivalDate}, ${shipments.promisedArrivalDate})`;
  const notArrived = sql`${shipments.actualArrivalDate} is null`;
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select({
      branch: sql<string>`coalesce(${shipments.branch}, ${NO_BRANCH})`,
      lines: sql<number>`count(*)::int`,
      awaitingShipment: sql<number>`count(*) filter (where ${shipments.status} = 'awaiting_shipment')::int`,
      inbound: sql<number>`count(*) filter (where ${notArrived} and ${expected} is not null)::int`,
      dueToday: sql<number>`count(*) filter (where ${notArrived} and ${expected} = ${today})::int`,
      next7Days: sql<number>`count(*) filter (where ${notArrived} and ${expected} > ${today} and ${expected} <= ${weekAhead})::int`,
      pastDue: sql<number>`count(*) filter (where ${notArrived} and ${expected} < ${today})::int`,
      arrivedLast30Days: sql<number>`count(*) filter (where ${shipments.actualArrivalDate} >= ${monthAgo})::int`,
    })
    .from(shipments)
    .groupBy(sql`1`)
    .orderBy(sql`2 desc, 1`); // most lines first
  return c.json(rows satisfies BranchSummary[]);
});
