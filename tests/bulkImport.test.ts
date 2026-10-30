import { Hono } from 'hono';
import { asc } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../server/db/client';
import { imports, lineChanges, shipments } from '../server/db/schema';
import type { AppEnv } from '../server/env';
import { createTestDb } from './helpers/testDb';

let db: Db;
vi.mock('../server/db/client', () => ({ getDb: () => db }));
const app = new Hono<AppEnv>().use('*', async (c, next) => {
  c.set('userId', 'tester');
  c.set('userLabel', 'tester@example.com');
  await next();
});
app.route('/imports', (await import('../server/routes/imports')).importsRoutes);
app.route('/outbound', (await import('../server/routes/outbound')).outboundRoutes);
app.route('/inventory', (await import('../server/routes/inventory')).inventoryRoutes);
app.route('/shipped', (await import('../server/routes/shipped')).shippedRoutes);

// The browser's api() calls, answered by the routes in-process.
vi.mock('../src/lib/api', () => ({
  api: async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, { ...init, headers: { 'Content-Type': 'application/json' } }, { DATABASE_URL: 'test' });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    return body;
  },
}));
const { importReportFile } = await import('../src/features/import/saveReport');
const { rebuildPoHistory } = await import('../src/features/import/rebuildHistory');

const HEADERS = ['Supplier Name', 'WintecPO', 'WintecPOLine', 'POStatus', 'ETADate', 'Branch', 'WintecPN', 'POOrderQty'];
/** A report with only the Supplier POs tab: [PO, status, ETA] per line. */
function report(lines: [string, string, string][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  const rows = lines.map(([po, status, eta]) => ['ACME', po, '1-1', status, eta, 'JIT-MSUS-META', `P-${po}`, 10]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, ...rows]), 'Supplier POs');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

const REPORTS: Record<string, ArrayBuffer> = {
  '2026-10-10': report([['PO1', 'Open', '2026-10-20'], ['PO2', 'Open', '2026-10-22']]),
  '2026-10-18': report([['PO1', 'Open', '2026-10-27'], ['PO2', 'Open', '2026-10-22'], ['PO3', 'Open', '2026-11-01']]),
  '2026-10-25': report([['PO1', 'Closed', '2026-10-27'], ['PO3', 'Open', '2026-11-05']]),
};
const importDate = (reportDate: string) => importReportFile(REPORTS[reportDate], { fileName: `report ${reportDate}.xlsx`, reportDate, mappings: [] }, () => {});

async function state() {
  const lines = await db.select().from(shipments).orderBy(asc(shipments.dedupeKey));
  const changes = await db.select().from(lineChanges);
  const keyById = new Map(lines.map((l) => [l.id, l.dedupeKey]));
  return {
    lines: lines.map((l) => [l.dedupeKey, l.status, l.poStatus, l.promisedArrivalDate, l.actualArrivalDate]),
    changes: changes.map((c) => [keyById.get(c.shipmentId), c.reportDate, c.kind, c.fromValue, c.toValue].join(' ')).sort(),
  };
}

describe('bulk import', () => {
  beforeEach(async () => {
    ({ db } = await createTestDb());
  });

  it('reads and saves a report file with the guessed columns', async () => {
    const result = await importDate('2026-10-10');
    expect(result).toEqual({ saved: ['2 PO lines'], notes: [], needsRebuild: false });
  });

  it('builds the same history from older reports added after a newer one, with one rebuild at the end', { timeout: 30_000 }, async () => {
    for (const d of ['2026-10-10', '2026-10-18', '2026-10-25']) await importDate(d);
    const inOrder = await state();
    expect(inOrder.changes).toContain('po:PO1:1-1: 2026-10-18 eta_changed 2026-10-20 2026-10-27');

    ({ db } = await createTestDb());
    await importDate('2026-10-25');
    const older = [await importDate('2026-10-10'), await importDate('2026-10-18')];
    expect(older.map((r) => r.needsRebuild)).toEqual([true, true]);
    await rebuildPoHistory(() => {});

    expect(await state()).toEqual(inOrder);
    expect((await db.select().from(imports)).map((i) => i.reportDate).sort()).toEqual(['2026-10-10', '2026-10-18', '2026-10-25']);
  });
});
