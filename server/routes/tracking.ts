import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/client';
import type { AppEnv } from '../env';
import { getProviders } from '../tracking/registry';
import { refreshTracking } from '../tracking/refresh';

export const trackingRoutes = new Hono<AppEnv>();

trackingRoutes.get('/status', (c) => {
  const providers = getProviders(c.env).map((p) => p.name);
  return c.json({ configured: providers.length > 0, providers });
});

const refreshSchema = z.object({
  scope: z.enum(['open', 'estimated']).default('open'),
  branch: z.string().nullish(),
  shipmentIds: z.array(z.number().int()).max(500).optional(),
  force: z.boolean().optional(),
});

/** Refreshes one batch; the client calls again while `remaining > 0`. */
trackingRoutes.post('/refresh', async (c) => {
  const body = refreshSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: 'Invalid request' }, 400);
  const providers = getProviders(c.env);
  if (!providers.length) {
    return c.json({ error: 'Tracking is not configured', reason: 'set the SHIP24_API_KEY secret' }, 503);
  }
  const result = await refreshTracking(getDb(c.env.DATABASE_URL), providers, body.data);
  return c.json(result);
});
