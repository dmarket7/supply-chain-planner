import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { trackingRuns } from '../db/schema';
import type { AppEnv } from '../env';
import { getProviders } from '../tracking/registry';
import { refreshTracking } from '../tracking/refresh';

export const trackingRoutes = new Hono<AppEnv>();

trackingRoutes.get('/status', (c) => {
  const providers = getProviders(c.env).map((p) => ({ name: p.name, carriers: p.carriers }));
  return c.json({ configured: providers.length > 0, providers });
});

const refreshSchema = z
  .object({
    scope: z.enum(['open', 'estimated', 'line']).default('open'),
    branch: z.string().nullish(),
    shipmentIds: z.array(z.number().int()).max(500).optional(),
    force: z.boolean().optional(),
    /** Returned by the first batch; send it with the following batches of the same run. */
    runId: z.number().int().optional(),
  })
  .refine((b) => b.scope !== 'line' || b.shipmentIds?.length, { message: 'shipmentIds required for scope "line"' });

/** Refreshes one batch; the client calls again (with `runId`) while `remaining > 0`. */
trackingRoutes.post('/refresh', async (c) => {
  const body = refreshSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: 'Invalid request' }, 400);
  const providers = getProviders(c.env);
  if (!providers.length) {
    return c.json({ error: 'Tracking is not configured', reason: 'no carrier API connections yet' }, 503);
  }
  const db = getDb(c.env.DATABASE_URL);
  let runId = body.data.runId;
  if (!runId) {
    const [run] = await db
      .insert(trackingRuns)
      .values({
        startedBy: c.get('userLabel'),
        scope: body.data.scope,
        branch: body.data.branch || null,
        provider: providers.map((p) => p.name).join(', '),
      })
      .returning({ id: trackingRuns.id });
    runId = run.id;
  }
  try {
    const result = await refreshTracking(db, providers, { ...body.data, runId });
    return c.json({ ...result, runId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(trackingRuns).set({ error: message, updatedAt: new Date() }).where(eq(trackingRuns.id, runId));
    console.error(`Tracking run ${runId} failed`, err);
    return c.json({ error: 'Tracking lookup failed', reason: message, runId }, 502);
  }
});

/** Most recent refresh runs, newest first. */
trackingRoutes.get('/runs', async (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 20, 100);
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(trackingRuns).orderBy(desc(trackingRuns.startedAt), desc(trackingRuns.id)).limit(limit);
  return c.json(rows);
});
