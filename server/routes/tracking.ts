import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/client';
import type { AppEnv } from '../env';
import { getProviders } from '../tracking/registry';
import { refreshTracking } from '../tracking/refresh';

export const trackingRoutes = new Hono<AppEnv>();

trackingRoutes.post('/refresh', async (c) => {
  const body = z
    .object({ shipmentIds: z.array(z.number().int()).optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: 'Invalid request' }, 400);
  const result = await refreshTracking(getDb(c.env.DATABASE_URL), getProviders(c.env), body.data.shipmentIds);
  return c.json(result);
});
