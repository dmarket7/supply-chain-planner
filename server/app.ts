import { Hono } from 'hono';
import { describeAuthUrlProblem, requireAuth } from './auth';
import type { AppEnv, Env } from './env';
import { branchesRoutes } from './routes/branches';
import { importsRoutes } from './routes/imports';
import { inventoryRoutes } from './routes/inventory';
import { shippedRoutes } from './routes/shipped';
import { mappingsRoutes } from './routes/mappings';
import { outboundRoutes } from './routes/outbound';
import { palletRatiosRoutes } from './routes/palletRatios';
import { progressRoutes } from './routes/progress';
import { performanceRoutes } from './routes/performance';
import { reportsRoutes } from './routes/reports';
import { shipmentsRoutes } from './routes/shipments';
import { trackingRoutes } from './routes/tracking';
import { trackingSetupRoutes } from './routes/trackingSetup';
import { fedexEnvironment, trackingMoreConfig } from './tracking/registry';

export const app = new Hono<AppEnv>().basePath('/api');

function describeTrackingMore(env: Env): string {
  switch (trackingMoreConfig(env).state) {
    case 'off':
      return 'not set (TrackingMore off)';
    case 'disabled':
      return 'key set, TRACKINGMORE_ENABLED is not "true" (off)';
    case 'missing_key':
      return 'TRACKINGMORE_ENABLED is true but TRACKINGMORE_API_KEY is missing';
    case 'ok':
      return 'ok';
  }
}

function describeFedEx(env: Env): string {
  const id = !!env.FEDEX_CLIENT_ID?.trim();
  const secret = !!env.FEDEX_CLIENT_SECRET?.trim();
  if (!id && !secret) return 'not set (FedEx tracking off)';
  if (!id || !secret) return `incomplete: ${id ? 'FEDEX_CLIENT_SECRET' : 'FEDEX_CLIENT_ID'} is missing`;
  const environment = fedexEnvironment(env);
  return environment ? `ok (${environment})` : 'FEDEX_ENV must be "sandbox" or "production"';
}

/** Public; reports whether the server settings look right, never their values. */
app.get('/health', (c) => {
  const authProblem = describeAuthUrlProblem(c.env.NEON_AUTH_URL);
  const databaseOk = /^postgres(ql)?:\/\//i.test(c.env.DATABASE_URL?.trim() ?? '');
  const ok = !authProblem && databaseOk;
  return c.json(
    {
      ok,
      config: {
        NEON_AUTH_URL: authProblem ?? 'ok',
        DATABASE_URL: databaseOk ? 'ok' : 'DATABASE_URL is missing or not a postgresql:// connection string',
        // Optional carrier connections.
        FEDEX: describeFedEx(c.env),
        TRACKINGMORE: describeTrackingMore(c.env),
      },
    },
    ok ? 200 : 500,
  );
});
app.use('*', requireAuth);
app.route('/branches', branchesRoutes);
app.route('/imports', importsRoutes);
app.route('/inventory', inventoryRoutes);
app.route('/shipped', shippedRoutes);
app.route('/mappings', mappingsRoutes);
app.route('/outbound', outboundRoutes);
app.route('/pallet-ratios', palletRatiosRoutes);
app.route('/shipments', shipmentsRoutes);
app.route('/reports/performance', performanceRoutes);
app.route('/reports', reportsRoutes);
app.route('/progress', progressRoutes);
app.route('/tracking', trackingRoutes);
app.route('/tracking', trackingSetupRoutes);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});
