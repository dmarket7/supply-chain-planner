import { Hono } from 'hono';
import { todayIso } from '../../shared/dates';
import { getDb } from '../db/client';
import type { AppEnv } from '../env';
import { periodOf, receivingPerformance, shippingPerformance, supplierDetail, supplierPerformance } from '../performance';

export const performanceRoutes = new Hono<AppEnv>();

/** Supplier on-time arrival and shipping against the first ETA/ETD our uploads recorded. */
performanceRoutes.get('/suppliers', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const q = c.req.query();
  return c.json(await supplierPerformance(db, { branch: q.branch, period: periodOf(q.period), includeHistory: q.includeHistory === '1', today: todayIso() }));
});

performanceRoutes.get('/suppliers/:name', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const q = c.req.query();
  return c.json(await supplierDetail(db, c.req.param('name'), { branch: q.branch, includeHistory: q.includeHistory === '1', today: todayIso() }));
});

/** Wintec's shipments against the confirmed ship date, the customer's request and SO ETD. */
performanceRoutes.get('/shipping', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const q = c.req.query();
  return c.json(await shippingPerformance(db, { branch: q.branch, period: periodOf(q.period), today: todayIso() }));
});

/** Past-due receipts per report and warehouse, and how long received stock waits to ship. */
performanceRoutes.get('/receiving', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  return c.json(await receivingPerformance(db, { branch: c.req.query('branch'), today: todayIso() }));
});
