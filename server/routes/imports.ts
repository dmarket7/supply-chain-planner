import { Hono } from 'hono';
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { baseDedupeKey } from '../../shared/importKeys';
import { importRowsSchema, startImportSchema, type ImportResult } from '../../shared/types';
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

/**
 * Step 1: create the import. Reports must be imported oldest first, because arrival windows are
 * measured from the previous report's date.
 */
importsRoutes.post('/', async (c) => {
  const parsed = startImportSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid import', issues: parsed.error.issues }, 400);
  const db = getDb(c.env.DATABASE_URL);

  const [latest] = await db
    .select({ reportDate: imports.reportDate })
    .from(imports)
    .where(isNotNull(imports.completedAt))
    .orderBy(desc(imports.reportDate))
    .limit(1);
  if (latest && parsed.data.reportDate < latest.reportDate) {
    return c.json(
      {
        error: `A newer report (${latest.reportDate}) has already been imported. Import reports oldest first.`,
      },
      409,
    );
  }

  const [row] = await db
    .insert(imports)
    .values({
      fileName: parsed.data.fileName,
      sheetName: parsed.data.sheetName ?? null,
      reportDate: parsed.data.reportDate,
      mappingId: parsed.data.mappingId ?? null,
      rowCount: parsed.data.rowCount,
      uploadedBy: c.get('userId'),
    })
    .returning({ id: imports.id });
  return c.json({ importId: row.id }, 201);
});

/** Step 2: upsert one chunk of rows (≤ IMPORT_CHUNK_SIZE). */
importsRoutes.post('/:id/rows', async (c) => {
  const importId = Number(c.req.param('id'));
  const parsed = importRowsSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid rows', issues: parsed.error.issues.slice(0, 10) }, 400);
  const { rows } = parsed.data;
  const bad = rows.find((r) => !r.dedupeKey.startsWith(baseDedupeKey(r)));
  if (bad) return c.json({ error: `Row key ${bad.dedupeKey} doesn't match its PO/line/ASN` }, 400);

  const db = getDb(c.env.DATABASE_URL);
  const [imp] = await db.select().from(imports).where(eq(imports.id, importId));
  if (!imp) return c.json({ error: 'Import not found' }, 404);
  if (imp.completedAt) return c.json({ error: 'Import already completed' }, 409);

  // Suppliers: create any new ones, then look up ids.
  const supplierNames = [...new Set(rows.map((r) => r.supplier))];
  await db.insert(suppliers).values(supplierNames.map((name) => ({ name }))).onConflictDoNothing();
  const supplierRows = await db.select().from(suppliers).where(inArray(suppliers.name, supplierNames));
  const supplierIds = new Map(supplierRows.map((s) => [s.name, s.id]));

  const existing = await db
    .select({
      id: shipments.id,
      dedupeKey: shipments.dedupeKey,
      poStatus: shipments.poStatus,
      status: shipments.status,
      promisedArrivalDate: shipments.promisedArrivalDate,
      actualArrivalDate: shipments.actualArrivalDate,
      arrivalSource: shipments.arrivalSource,
      arrivalWindowStart: shipments.arrivalWindowStart,
      arrivalWindowEnd: shipments.arrivalWindowEnd,
      lastSeenOpenReportDate: shipments.lastSeenOpenReportDate,
      lastTrackedAt: shipments.lastTrackedAt,
    })
    .from(shipments)
    .where(inArray(shipments.dedupeKey, rows.map((r) => r.dedupeKey)));
  const plan = planImport(rows, existing, imp.reportDate);

  const upsert = db
    .insert(shipments)
    .values(
      plan.rows.map((r) => ({
        dedupeKey: r.dedupeKey,
        supplierId: supplierIds.get(r.supplier)!,
        poNumber: r.poNumber ?? null,
        lineRef: r.lineRef ?? null,
        asn: r.asn ?? null,
        poStatus: r.poStatus ?? null,
        customerPo: r.customerPo ?? null,
        partNumber: r.partNumber ?? null,
        itemDescription: r.itemDescription ?? null,
        commodity: r.commodity ?? null,
        branch: r.branch ?? null,
        warehouse: r.warehouse ?? null,
        quantity: r.quantity ?? null,
        carrier: r.carrier ?? null,
        mode: r.mode ?? null,
        trackingNumber: r.trackingNumber ?? null,
        trackingRef: r.trackingRef ?? null,
        requestDate: r.requestDate ?? null,
        shipDate: r.shipDate ?? null,
        promisedArrivalDate: r.promisedArrivalDate,
        actualArrivalDate: r.actualArrivalDate,
        arrivalSource: r.arrivalSource,
        arrivalWindowStart: r.arrivalWindowStart,
        arrivalWindowEnd: r.arrivalWindowEnd,
        lastSeenOpenReportDate: r.lastSeenOpenReportDate,
        status: r.status,
        sourceRow: r.sourceRow ?? null,
        firstImportId: importId,
        lastImportId: importId,
      })),
    )
    .onConflictDoUpdate({
      target: shipments.dedupeKey,
      // planRow already merged the previous state, so the incoming values win, except carrier/mode,
      // which a later report may leave blank.
      set: {
        supplierId: sql`excluded.supplier_id`,
        poNumber: sql`excluded.po_number`,
        lineRef: sql`excluded.line_ref`,
        asn: sql`excluded.asn`,
        poStatus: sql`excluded.po_status`,
        customerPo: sql`excluded.customer_po`,
        partNumber: sql`excluded.part_number`,
        itemDescription: sql`excluded.item_description`,
        commodity: sql`excluded.commodity`,
        branch: sql`excluded.branch`,
        warehouse: sql`excluded.warehouse`,
        quantity: sql`excluded.quantity`,
        carrier: sql`coalesce(excluded.carrier, ${shipments.carrier})`,
        mode: sql`coalesce(excluded.mode, ${shipments.mode})`,
        trackingNumber: sql`excluded.tracking_number`,
        trackingRef: sql`excluded.tracking_ref`,
        requestDate: sql`excluded.request_date`,
        shipDate: sql`excluded.ship_date`,
        promisedArrivalDate: sql`excluded.promised_arrival_date`,
        actualArrivalDate: sql`excluded.actual_arrival_date`,
        arrivalSource: sql`excluded.arrival_source`,
        arrivalWindowStart: sql`excluded.arrival_window_start`,
        arrivalWindowEnd: sql`excluded.arrival_window_end`,
        lastSeenOpenReportDate: sql`excluded.last_seen_open_report_date`,
        status: sql`excluded.status`,
        sourceRow: sql`excluded.source_row`,
        lastImportId: sql`excluded.last_import_id`,
        updatedAt: sql`now()`,
      },
    });

  const idByKey = new Map(existing.map((e) => [e.dedupeKey, e.id]));
  const history = plan.promisedDateChanges.map((ch) => ({
    shipmentId: idByKey.get(ch.dedupeKey)!,
    previousDate: ch.previousDate,
    newDate: ch.newDate,
    importId,
  }));
  const counters = db
    .update(imports)
    .set({
      inserted: sql`${imports.inserted} + ${plan.insertCount}`,
      updated: sql`${imports.updated} + ${plan.updateCount}`,
      promisedDateChanges: sql`${imports.promisedDateChanges} + ${history.length}`,
      newlyClosed: sql`${imports.newlyClosed} + ${plan.newlyClosed}`,
    })
    .where(eq(imports.id, importId));

  // db.batch runs the statements in one transaction over the HTTP driver.
  await db.batch([upsert, counters, ...chunk(history, 500).map((part) => db.insert(promisedDateHistory).values(part))]);

  return c.json({ inserted: plan.insertCount, updated: plan.updateCount });
});

/**
 * Step 3: finish. The report is a snapshot, so "awaiting shipment" lines it no longer lists have
 * either shipped (and now appear under their ASN) or were cancelled; remove them.
 */
importsRoutes.post('/:id/complete', async (c) => {
  const importId = Number(c.req.param('id'));
  const db = getDb(c.env.DATABASE_URL);
  const [imp] = await db.select().from(imports).where(eq(imports.id, importId));
  if (!imp) return c.json({ error: 'Import not found' }, 404);

  if (!imp.completedAt) {
    const removed = await db
      .delete(shipments)
      .where(and(eq(shipments.status, 'awaiting_shipment'), ne(shipments.lastImportId, importId)))
      .returning({ id: shipments.id });
    await db
      .update(imports)
      .set({ completedAt: new Date(), removedAwaiting: removed.length })
      .where(eq(imports.id, importId));
    imp.removedAwaiting = removed.length;
  }

  const result: ImportResult = {
    importId,
    inserted: imp.inserted,
    updated: imp.updated,
    promisedDateChanges: imp.promisedDateChanges,
    newlyClosed: imp.newlyClosed,
    removedAwaiting: imp.removedAwaiting,
  };
  return c.json(result);
});
