import { Hono } from 'hono';
import { desc } from 'drizzle-orm';
import type { ProgressSummary } from '../../shared/types';
import { getDb } from '../db/client';
import { activeImport } from '../poHistory';
import { imports } from '../db/schema';
import type { AppEnv } from '../env';
import { progressCounts } from '../progress';
import { branchFilter } from './common';

export const progressRoutes = new Hono<AppEnv>();

/** What the latest upload changed compared with the one before it (optionally for one branch). */
progressRoutes.get('/latest', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const [latest, previous] = await db
    .select({ id: imports.id, reportDate: imports.reportDate, fileName: imports.fileName, removedAwaiting: imports.removedAwaiting })
    .from(imports)
    .where(activeImport)
    .orderBy(desc(imports.reportDate), desc(imports.id))
    .limit(2);
  if (!latest) return c.json(null);
  const branch = c.req.query('branch');
  const summary: ProgressSummary = {
    importId: latest.id,
    reportDate: latest.reportDate,
    fileName: latest.fileName,
    previousReportDate: previous && previous.reportDate < latest.reportDate ? previous.reportDate : null,
    counts: await progressCounts(db, latest.id, branchFilter(branch)),
    // Dropped lines are deleted, so their branch is unknown: only reported for all branches.
    removedAwaiting: branch ? null : latest.removedAwaiting,
  };
  return c.json(summary);
});
