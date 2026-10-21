import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { Db } from '../../server/db/client';
import * as schema from '../../server/db/schema';

/**
 * In-process Postgres (PGlite) with every migration in drizzle/ applied, shaped like the app's Neon
 * HTTP database. `db.batch` runs its statements in order, as the Neon driver does in one transaction.
 */
export async function createTestDb(): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite();
  const dir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  const db = drizzle(client, { schema }) as unknown as Db & { batch: (qs: unknown[]) => Promise<unknown[]> };
  (db as { batch: (qs: PromiseLike<unknown>[]) => Promise<unknown[]> }).batch = async (queries) => {
    const out: unknown[] = [];
    for (const q of queries) out.push(await q);
    return out;
  };
  return { db, client };
}

let supplierSeq = 0;
/** Inserts a supplier and shipments; returns their ids in order. */
export async function seedShipments(db: Db, rows: Partial<typeof schema.shipments.$inferInsert>[]): Promise<number[]> {
  const [supplier] = await db.insert(schema.suppliers).values({ name: `Supplier ${++supplierSeq}` }).returning({ id: schema.suppliers.id });
  const ids: number[] = [];
  for (const [i, r] of rows.entries()) {
    const [row] = await db
      .insert(schema.shipments)
      .values({ dedupeKey: `test:${supplierSeq}:${i}:${Math.random()}`, supplierId: supplier.id, status: 'in_transit', ...r })
      .returning({ id: schema.shipments.id });
    ids.push(row.id);
  }
  return ids;
}
