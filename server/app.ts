import { Hono } from 'hono';
import { requireAuth } from './auth';
import type { AppEnv } from './env';
import { importsRoutes } from './routes/imports';
import { mappingsRoutes } from './routes/mappings';
import { reportsRoutes } from './routes/reports';
import { shipmentsRoutes } from './routes/shipments';
import { trackingRoutes } from './routes/tracking';

export const app = new Hono<AppEnv>().basePath('/api');

app.get('/health', (c) => c.json({ ok: true }));
app.use('*', requireAuth);
app.route('/imports', importsRoutes);
app.route('/mappings', mappingsRoutes);
app.route('/shipments', shipmentsRoutes);
app.route('/reports', reportsRoutes);
app.route('/tracking', trackingRoutes);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});
