import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from './db/client';
import { imports, lineChanges, poLineVersions, poReportLines, promisedDateHistory, shipments, suppliers } from './db/schema';
import { replayImports, type IncomingRow, type PlannedRow, type ReplayImport } from './importPlan';
import { chunk } from './routes/common';

/** Lines of one PO are replayed together; a line without a PO number is its own group. */
export const groupKeyOf = (r: { poNumber?: string | null; dedupeKey: string }) => r.poNumber ?? `key:${r.dedupeKey}`;
const groupKeySql = sql<string>`coalesce(${shipments.poNumber}, 'key:' || ${shipments.dedupeKey})`;

/** Imports that count: completed and not deleted. */
export const activeImport = and(isNotNull(imports.completedAt), isNull(imports.deletedAt));

type ShipmentRowInput = PlannedRow & { supplierId: number; firstImportId: number; lastImportId: number };

/**
 * Writes planned lines. A report's values win, except carrier and mode, which a later report may
 * leave blank. `replaceFirstImport` is for a rebuild, which recomputes when each line was first listed.
 */
export function upsertShipments(db: Db, rows: ShipmentRowInput[], replaceFirstImport = false) {
  return db
    .insert(shipments)
    .values(
      rows.map((r) => ({
        dedupeKey: r.dedupeKey,
        supplierId: r.supplierId,
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
        firstImportId: r.firstImportId,
        lastImportId: r.lastImportId,
      })),
    )
    .onConflictDoUpdate({
      target: shipments.dedupeKey,
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
        carrier: replaceFirstImport ? sql`excluded.carrier` : sql`coalesce(excluded.carrier, ${shipments.carrier})`,
        mode: replaceFirstImport ? sql`excluded.mode` : sql`coalesce(excluded.mode, ${shipments.mode})`,
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
        ...(replaceFirstImport ? { firstImportId: sql`excluded.first_import_id` } : {}),
        lastImportId: sql`excluded.last_import_id`,
        updatedAt: sql`now()`,
      },
    });
}

async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Keeps one chunk of a report's rows, sharing versions with earlier reports where nothing changed. */
export async function storeReportLines(db: Db, importId: number, rows: IncomingRow[]) {
  const input = await Promise.all(
    rows.map(async (r) => {
      const data = JSON.stringify(r);
      return { dedupe_key: r.dedupeKey, group_key: groupKeyOf(r), hash: await sha1(data), data: JSON.parse(data) as unknown };
    }),
  );
  // Rows inserted by the CTE aren't visible to the same statement's join, hence the coalesce.
  return db.execute(sql`
    with input as (
      select * from json_to_recordset(${JSON.stringify(input)}::json) as x(dedupe_key text, group_key text, hash text, data jsonb)
    ), ins as (
      insert into ${poLineVersions} (dedupe_key, group_key, hash, data)
      select dedupe_key, group_key, hash, data from input
      on conflict (dedupe_key, hash) do nothing
      returning id, dedupe_key, hash
    )
    insert into ${poReportLines} (import_id, version_id)
    select ${importId}, coalesce(ins.id, v.id)
    from input
    left join ins on ins.dedupe_key = input.dedupe_key and ins.hash = input.hash
    left join ${poLineVersions} v on v.dedupe_key = input.dedupe_key and v.hash = input.hash
    on conflict do nothing`);
}

/** Reports that count but were imported before their rows were kept, so they can't be replayed. */
export async function legacyReportDates(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ reportDate: imports.reportDate })
    .from(imports)
    .where(and(activeImport, eq(imports.linesStored, false)))
    .orderBy(asc(imports.reportDate));
  return rows.map((r) => r.reportDate);
}

/** Roughly how many stored line versions one rebuild request replays. */
const REBUILD_BUDGET = 400;

/**
 * Starts a rebuild: resets the per-report counters and returns the POs to replay, in batches. It
 * covers POs in the kept reports and POs of current lines, so lines only a deleted report had go.
 */
export async function startRebuild(db: Db): Promise<string[][]> {
  const [sizes, current] = await Promise.all([
    db
      .select({ groupKey: poLineVersions.groupKey, n: sql<number>`count(*)::int` })
      .from(poReportLines)
      .innerJoin(poLineVersions, eq(poLineVersions.id, poReportLines.versionId))
      .innerJoin(imports, eq(imports.id, poReportLines.importId))
      .where(activeImport)
      .groupBy(poLineVersions.groupKey),
    db.selectDistinct({ groupKey: groupKeySql }).from(shipments),
  ]);
  await db.update(imports).set({ inserted: 0, updated: 0, promisedDateChanges: 0, newlyClosed: 0, removedAwaiting: 0 }).where(activeImport);
  const size = new Map(sizes.map((s) => [s.groupKey, s.n]));
  for (const c of current) if (!size.has(c.groupKey)) size.set(c.groupKey, 1);
  const batches: string[][] = [];
  let batch: string[] = [];
  let load = 0;
  for (const [key, n] of [...size].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (batch.length && load + n > REBUILD_BUDGET) {
      batches.push(batch);
      batch = [];
      load = 0;
    }
    batch.push(key);
    load += n;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

const CONFIRMED_SOURCES = ['manual', 'tracking'];
const TRACKING_ONLY = ['out_for_delivery', 'exception', 'unknown'];

/**
 * Replays the kept reports for some POs and writes the result: their lines, change log, ETA history
 * and the reports' counters. Arrivals confirmed by hand or by tracking, and statuses only tracking
 * sets, are kept as they are.
 */
export async function rebuildGroups(db: Db, groupKeys: string[]): Promise<void> {
  if (!groupKeys.length) return;
  const [reports, versions, current] = await Promise.all([
    db.select({ id: imports.id, reportDate: imports.reportDate }).from(imports).where(activeImport).orderBy(asc(imports.reportDate), asc(imports.id)),
    db
      .select({ importId: poReportLines.importId, data: poLineVersions.data })
      .from(poReportLines)
      .innerJoin(poLineVersions, eq(poLineVersions.id, poReportLines.versionId))
      .where(inArray(poLineVersions.groupKey, groupKeys)),
    db
      .select({
        id: shipments.id,
        dedupeKey: shipments.dedupeKey,
        status: shipments.status,
        actualArrivalDate: shipments.actualArrivalDate,
        arrivalSource: shipments.arrivalSource,
        arrivalWindowStart: shipments.arrivalWindowStart,
        arrivalWindowEnd: shipments.arrivalWindowEnd,
        lastTrackedAt: shipments.lastTrackedAt,
      })
      .from(shipments)
      .where(inArray(groupKeySql, groupKeys)),
  ]);
  const rowsByImport = new Map<number, IncomingRow[]>();
  for (const v of versions) {
    const list = rowsByImport.get(v.importId) ?? [];
    list.push(v.data as IncomingRow);
    rowsByImport.set(v.importId, list);
  }
  const replay = replayImports(reports.map((r): ReplayImport => ({ ...r, rows: rowsByImport.get(r.id) ?? [] })));

  const now = new Map(current.map((c) => [c.dedupeKey, c]));
  const lines = [...replay.lines.values()].map((l) => {
    const db = now.get(l.dedupeKey);
    if (db && CONFIRMED_SOURCES.includes(db.arrivalSource ?? '') && db.actualArrivalDate) {
      return { ...l, status: 'delivered' as const, actualArrivalDate: db.actualArrivalDate, arrivalSource: db.arrivalSource, arrivalWindowStart: db.arrivalWindowStart, arrivalWindowEnd: db.arrivalWindowEnd };
    }
    if (db?.lastTrackedAt && TRACKING_ONLY.includes(db.status) && l.status !== 'delivered') return { ...l, status: db.status };
    return l;
  });
  const gone = current.filter((c) => !replay.lines.has(c.dedupeKey)).map((c) => c.id);
  const kept = current.filter((c) => replay.lines.has(c.dedupeKey)).map((c) => c.id);

  const names = [...new Set(lines.map((l) => l.supplier))];
  if (names.length) await db.insert(suppliers).values(names.map((name) => ({ name }))).onConflictDoNothing();
  const supplierIds = new Map((names.length ? await db.select().from(suppliers).where(inArray(suppliers.name, names)) : []).map((s) => [s.name, s.id]));

  const statements = [
    ...chunk(lines, 200).map((part) => upsertShipments(db, part.map((l) => ({ ...l, supplierId: supplierIds.get(l.supplier)! })), true)),
    ...chunk(gone, 500).map((ids) => db.delete(shipments).where(inArray(shipments.id, ids))),
    ...chunk(kept, 500).flatMap((ids) => [
      db.delete(lineChanges).where(and(inArray(lineChanges.shipmentId, ids), isNotNull(lineChanges.importId))),
      db.delete(promisedDateHistory).where(inArray(promisedDateHistory.shipmentId, ids)),
    ]),
    ...chunk(replay.changes, 500).map((part) =>
      db.execute(sql`
        insert into ${lineChanges} (shipment_id, import_id, report_date, kind, from_value, to_value)
        select s.id, c.import_id, c.report_date, c.kind, c.from_value, c.to_value
        from json_to_recordset(${JSON.stringify(part.map((c) => ({ dedupe_key: c.dedupeKey, import_id: c.importId, report_date: c.reportDate, kind: c.kind, from_value: c.from, to_value: c.to })))}::json)
          as c(dedupe_key text, import_id int, report_date date, kind text, from_value text, to_value text)
        join ${shipments} s on s.dedupe_key = c.dedupe_key`),
    ),
    ...chunk(replay.promisedDateChanges, 500).map((part) =>
      db.execute(sql`
        insert into ${promisedDateHistory} (shipment_id, previous_date, new_date, import_id)
        select s.id, c.previous_date, c.new_date, c.import_id
        from json_to_recordset(${JSON.stringify(part.map((c) => ({ dedupe_key: c.dedupeKey, previous_date: c.previousDate, new_date: c.newDate, import_id: c.importId })))}::json)
          as c(dedupe_key text, previous_date date, new_date date, import_id int)
        join ${shipments} s on s.dedupe_key = c.dedupe_key`),
    ),
  ];
  const counts = [...replay.counts].filter(([, c]) => Object.values(c).some(Boolean));
  if (counts.length) {
    statements.push(
      db.execute(sql`
        update ${imports} i set
          inserted = i.inserted + c.inserted,
          updated = i.updated + c.updated,
          promised_date_changes = i.promised_date_changes + c.promised,
          newly_closed = i.newly_closed + c.closed,
          removed_awaiting = i.removed_awaiting + c.removed
        from json_to_recordset(${JSON.stringify(counts.map(([id, c]) => ({ id, inserted: c.inserted, updated: c.updated, promised: c.promisedDateChanges, closed: c.newlyClosed, removed: c.removedAwaiting })))}::json)
          as c(id int, inserted int, updated int, promised int, closed int, removed int)
        where i.id = c.id`),
    );
  }
  if (statements.length) await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
}

/** Ends a rebuild: deleted reports and line versions no report uses any more go. */
export async function finishRebuild(db: Db): Promise<void> {
  await db.delete(imports).where(isNotNull(imports.deletedAt));
  await db.execute(sql`delete from ${poLineVersions} v where not exists (select 1 from ${poReportLines} l where l.version_id = v.id)`);
}
