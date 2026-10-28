import { Hono } from 'hono';
import { and, desc, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { baseDedupeKey } from '../../shared/importKeys';
import { importRowsSchema, startImportSchema, type ImportHistoryRow, type ImportResult } from '../../shared/types';
import { getDb } from '../db/client';
import { imports, inventoryPositions, inventorySnapshots, lineChanges, outboundSnapshots, promisedDateHistory, shipments, suppliers } from '../db/schema';
import type { AppEnv } from '../env';
import { availableBySite } from '../inventory';
import { changeSummary } from '../outbound';
import { planImport, poLineKey } from '../importPlan';
import { progressCounts } from '../progress';
import { chunk } from './common';

export const importsRoutes = new Hono<AppEnv>();

importsRoutes.get('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(imports).orderBy(desc(imports.uploadedAt)).limit(50);
  return c.json(rows);
});

const HISTORY_REPORTS = 12;

/**
 * What changed in each recent report, per tab: PO line progress, sales order changes, and parts
 * whose available stock went up or down at a site.
 */
importsRoutes.get('/history', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const newestFirst = <T extends { reportDate: string; id: number }>(rows: T[]) => {
    const byDate = new Map<string, T>();
    for (const r of rows) {
      const cur = byDate.get(r.reportDate);
      if (!cur || r.id > cur.id) byDate.set(r.reportDate, r);
    }
    return [...byDate.values()].sort((a, b) => b.reportDate.localeCompare(a.reportDate)).slice(0, HISTORY_REPORTS + 1);
  };
  const [poRows, outRows, invRows] = await Promise.all([
    db.select({ id: imports.id, reportDate: imports.reportDate, fileName: imports.fileName }).from(imports).where(isNotNull(imports.completedAt)),
    db
      .select({ id: outboundSnapshots.id, reportDate: outboundSnapshots.reportDate, orderCount: outboundSnapshots.orderCount })
      .from(outboundSnapshots)
      .where(isNotNull(outboundSnapshots.completedAt)),
    db
      .select({ id: inventorySnapshots.id, reportDate: inventorySnapshots.reportDate, positionCount: inventorySnapshots.positionCount })
      .from(inventorySnapshots)
      .where(isNotNull(inventorySnapshots.completedAt)),
  ]);
  const po = newestFirst(poRows);
  const out = newestFirst(outRows);
  const inv = newestFirst(invRows);

  const positions = inv.length
    ? await db
        .select({ snapshotId: inventoryPositions.snapshotId, partNumber: inventoryPositions.partNumber, branch: inventoryPositions.branch, available: inventoryPositions.available })
        .from(inventoryPositions)
        .where(inArray(inventoryPositions.snapshotId, inv.map((s) => s.id)))
    : [];
  const available = new Map(inv.map((s) => [s.id, availableBySite(positions.filter((p) => p.snapshotId === s.id))]));

  const [poCounts, outSummaries] = await Promise.all([
    Promise.all(po.map((i) => progressCounts(db, i.id))),
    Promise.all(out.map((s, i) => (out[i + 1] ? changeSummary(db, s.id) : null))),
  ]);

  const dates = [...new Set([...po, ...out, ...inv].map((r) => r.reportDate))].sort().reverse().slice(0, HISTORY_REPORTS);
  const rows: ImportHistoryRow[] = dates.map((reportDate) => {
    const pi = po.findIndex((r) => r.reportDate === reportDate);
    const oi = out.findIndex((r) => r.reportDate === reportDate);
    const ii = inv.findIndex((r) => r.reportDate === reportDate);
    let inventory: ImportHistoryRow['inventory'] = null;
    if (ii >= 0) {
      const now = available.get(inv[ii].id)!;
      const before = inv[ii + 1] ? available.get(inv[ii + 1].id)! : null;
      let up = 0;
      let down = 0;
      if (before) {
        for (const key of new Set([...now.keys(), ...before.keys()])) {
          const d = (now.get(key) ?? 0) - (before.get(key) ?? 0);
          if (d > 0) up++;
          else if (d < 0) down++;
        }
      }
      inventory = { snapshotId: inv[ii].id, positionCount: inv[ii].positionCount, up: before ? up : null, down: before ? down : null };
    }
    return {
      reportDate,
      inbound: pi >= 0 ? { importId: po[pi].id, fileName: po[pi].fileName, counts: poCounts[pi] } : null,
      outbound: oi >= 0 ? { snapshotId: out[oi].id, orderCount: out[oi].orderCount, summary: outSummaries[oi] } : null,
      inventory,
    };
  });
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
      shipDate: shipments.shipDate,
      trackingNumber: shipments.trackingNumber,
    })
    .from(shipments)
    .where(inArray(shipments.dedupeKey, rows.map((r) => r.dedupeKey)));

  // PO lines an earlier report listed as awaiting shipment: a new ASN line for one of them has just shipped.
  const known = new Set(existing.map((e) => e.dedupeKey));
  const newAsnPos = [...new Set(rows.filter((r) => r.asn && r.poNumber && !known.has(r.dedupeKey)).map((r) => r.poNumber!))];
  const awaiting = newAsnPos.length
    ? await db
        .select({ poNumber: shipments.poNumber, lineRef: shipments.lineRef })
        .from(shipments)
        .where(and(eq(shipments.status, 'awaiting_shipment'), inArray(shipments.poNumber, newAsnPos)))
    : [];
  const awaitingPoLines = new Set(awaiting.map((a) => poLineKey(a)).filter((k): k is string => !!k));

  const plan = planImport(rows, existing, imp.reportDate, awaitingPoLines);

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

  // Progress log; new lines get their id from the upsert above, so join on the dedupe key.
  const changeLog = chunk(plan.changes, 500).map((part) =>
    db.execute(sql`
      insert into ${lineChanges} (shipment_id, import_id, report_date, kind, from_value, to_value)
      select s.id, ${importId}, ${imp.reportDate}::date, c.kind, c.from_value, c.to_value
      from json_to_recordset(${JSON.stringify(part.map((ch) => ({ dedupe_key: ch.dedupeKey, kind: ch.kind, from_value: ch.from, to_value: ch.to })))}::json)
        as c(dedupe_key text, kind text, from_value text, to_value text)
      join ${shipments} s on s.dedupe_key = c.dedupe_key`),
  );

  // db.batch runs the statements in one transaction over the HTTP driver.
  await db.batch([
    upsert,
    counters,
    ...chunk(history, 500).map((part) => db.insert(promisedDateHistory).values(part)),
    ...changeLog,
  ]);

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
    const stale = and(eq(shipments.status, 'awaiting_shipment'), ne(shipments.lastImportId, importId));
    // Before dropping an awaiting line that has shipped, copy its history (e.g. "first listed") onto the
    // line(s) now listed under an ASN for the same PO line, so the timeline starts at the order.
    const carryOver = db.execute(sql`
      insert into ${lineChanges} (shipment_id, import_id, report_date, kind, from_value, to_value)
      select shipped.id, lc.import_id, lc.report_date, lc.kind, lc.from_value, lc.to_value
      from ${lineChanges} lc
      join ${shipments} old on old.id = lc.shipment_id
      join ${shipments} shipped on shipped.po_number = old.po_number
        and coalesce(shipped.line_ref, '') = coalesce(old.line_ref, '')
        and shipped.id <> old.id
        and shipped.last_import_id = ${importId}
      where old.status = 'awaiting_shipment' and old.last_import_id <> ${importId}`);
    const [, removed] = await db.batch([
      carryOver,
      db.delete(shipments).where(stale).returning({ id: shipments.id }),
    ]);
    await db
      .update(imports)
      .set({ completedAt: new Date(), removedAwaiting: removed.length })
      .where(eq(imports.id, importId));
    imp.removedAwaiting = removed.length;
  }

  const [[previous], progress] = await Promise.all([
    db
      .select({ reportDate: imports.reportDate })
      .from(imports)
      .where(and(isNotNull(imports.completedAt), lt(imports.reportDate, imp.reportDate)))
      .orderBy(desc(imports.reportDate))
      .limit(1),
    progressCounts(db, importId),
  ]);

  const result: ImportResult = {
    importId,
    inserted: imp.inserted,
    updated: imp.updated,
    promisedDateChanges: imp.promisedDateChanges,
    newlyClosed: imp.newlyClosed,
    removedAwaiting: imp.removedAwaiting,
    progress,
    previousReportDate: previous?.reportDate ?? null,
  };
  return c.json(result);
});
