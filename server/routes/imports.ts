import { Hono } from 'hono';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { importRequestSchema, type ImportResult } from '../../shared/types';
import { getDb } from '../db/client';
import { imports, promisedDateHistory, shipments, suppliers } from '../db/schema';
import type { AppEnv } from '../env';
import { planImport } from '../importPlan';
import { chunk } from './common';

export const importsRoutes = new Hono<AppEnv>();

importsRoutes.get('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(imports).orderBy(desc(imports.uploadedAt)).limit(50);
  return c.json(rows);
});

importsRoutes.post('/', async (c) => {
  const parsed = importRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid import', issues: parsed.error.issues }, 400);
  const { fileName, mappingId, rows } = parsed.data;
  const db = getDb(c.env.DATABASE_URL);

  // 1. Suppliers: create any new ones, then look up ids.
  const supplierNames = [...new Set(rows.map((r) => r.supplier))];
  await db.insert(suppliers).values(supplierNames.map((name) => ({ name }))).onConflictDoNothing();
  const supplierRows = await db.select().from(suppliers).where(inArray(suppliers.name, supplierNames));
  const supplierIds = new Map(supplierRows.map((s) => [s.name, s.id]));

  // 2. Find shipments this file already knows about.
  const draft = planImport(rows, supplierIds, []);
  const keys = draft.rows.map((r) => r.dedupeKey);
  const existing = (
    await Promise.all(
      chunk(keys, 1000).map((part) =>
        db
          .select({
            id: shipments.id,
            dedupeKey: shipments.dedupeKey,
            promisedArrivalDate: shipments.promisedArrivalDate,
          })
          .from(shipments)
          .where(inArray(shipments.dedupeKey, part)),
      ),
    )
  ).flat();
  const plan = planImport(rows, supplierIds, existing);

  const [importRow] = await db
    .insert(imports)
    .values({
      fileName,
      mappingId: mappingId ?? null,
      uploadedBy: c.get('userId'),
      rowCount: rows.length,
      inserted: plan.insertCount,
      updated: plan.updateCount,
    })
    .returning({ id: imports.id });

  // 3. Upsert shipments. An arrival date in the report only fills an empty arrival;
  //    it never overwrites one recorded manually or from tracking.
  const upserts = chunk(plan.rows, 400).map((part) =>
    db
      .insert(shipments)
      .values(
        part.map((r) => ({
          dedupeKey: r.dedupeKey,
          supplierId: r.supplierId,
          poNumber: r.poNumber ?? null,
          lineRef: r.lineRef ?? null,
          itemDescription: r.itemDescription ?? null,
          quantity: r.quantity ?? null,
          carrier: r.carrier ?? null,
          mode: r.mode ?? null,
          trackingNumber: r.trackingNumber ?? null,
          shipDate: r.shipDate ?? null,
          promisedArrivalDate: r.promisedArrivalDate,
          actualArrivalDate: r.actualArrivalDate ?? null,
          arrivalSource: r.actualArrivalDate ? ('import' as const) : null,
          status: r.actualArrivalDate ? ('delivered' as const) : ('pending' as const),
          firstImportId: importRow.id,
          lastImportId: importRow.id,
        })),
      )
      .onConflictDoUpdate({
        target: shipments.dedupeKey,
        set: {
          supplierId: sql`excluded.supplier_id`,
          poNumber: sql`excluded.po_number`,
          lineRef: sql`excluded.line_ref`,
          itemDescription: sql`excluded.item_description`,
          quantity: sql`excluded.quantity`,
          carrier: sql`coalesce(excluded.carrier, ${shipments.carrier})`,
          mode: sql`coalesce(excluded.mode, ${shipments.mode})`,
          trackingNumber: sql`excluded.tracking_number`,
          shipDate: sql`excluded.ship_date`,
          promisedArrivalDate: sql`excluded.promised_arrival_date`,
          actualArrivalDate: sql`coalesce(${shipments.actualArrivalDate}, excluded.actual_arrival_date)`,
          arrivalSource: sql`coalesce(${shipments.arrivalSource}, excluded.arrival_source)`,
          status: sql`case when ${shipments.actualArrivalDate} is null and excluded.actual_arrival_date is not null
                        then 'delivered'::shipment_status else ${shipments.status} end`,
          lastImportId: sql`excluded.last_import_id`,
          updatedAt: sql`now()`,
        },
      }),
  );

  const idByKey = new Map(existing.map((e) => [e.dedupeKey, e.id]));
  const history = plan.promisedDateChanges.map((ch) => ({
    shipmentId: idByKey.get(ch.dedupeKey)!,
    previousDate: ch.previousDate,
    newDate: ch.newDate,
    importId: importRow.id,
  }));
  const historyInserts = chunk(history, 1000).map((part) => db.insert(promisedDateHistory).values(part));

  const statements = [...upserts, ...historyInserts];
  // db.batch runs all statements in one transaction over the HTTP driver.
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);

  const result: ImportResult = {
    importId: importRow.id,
    inserted: plan.insertCount,
    updated: plan.updateCount,
    promisedDateChanges: history.length,
  };
  return c.json(result, 201);
});

importsRoutes.get('/:id', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db.select().from(imports).where(eq(imports.id, Number(c.req.param('id'))));
  return row ? c.json(row) : c.json({ error: 'Not found' }, 404);
});
