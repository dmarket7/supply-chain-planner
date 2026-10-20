import { Hono } from 'hono';
import { describeAuthUrlProblem, requireAuth } from './auth';
import type { AppEnv } from './env';
import { branchesRoutes } from './routes/branches';
import { importsRoutes } from './routes/imports';
import { mappingsRoutes } from './routes/mappings';
import { progressRoutes } from './routes/progress';
import { reportsRoutes } from './routes/reports';
import { shipmentsRoutes } from './routes/shipments';
import { trackingRoutes } from './routes/tracking';

export const app = new Hono<AppEnv>().basePath('/api');

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
      },
    },
    ok ? 200 : 500,
  );
});
app.use('*', requireAuth);
app.route('/branches', branchesRoutes);
app.route('/imports', importsRoutes);
app.route('/mappings', mappingsRoutes);
app.route('/shipments', shipmentsRoutes);
app.route('/reports', reportsRoutes);
app.route('/progress', progressRoutes);
app.route('/tracking', trackingRoutes);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});
