import { Hono } from 'hono';
import { eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { RatioLookup, type RatioValues } from '../../shared/pallets';
import {
  palletRatioEditSchema,
  palletRatioImportSchema,
  type PalletRatioFileRow,
  type PalletRatioImportResult,
  type PalletRatioRow,
  type PalletRatiosResponse,
} from '../../shared/types';
import { getDb } from '../db/client';
import { palletRatios, shipments } from '../db/schema';
import type { AppEnv } from '../env';
import { chunk } from './common';

export const palletRatiosRoutes = new Hono<AppEnv>();

const sameValues = (a: RatioValues, b: RatioValues) =>
  a.unitsPerPallet === b.unitsPerPallet && a.palletsPerTruck === b.palletsPerTruck;

const valuesOf = (r: RatioValues): RatioValues => ({ unitsPerPallet: r.unitsPerPallet, palletsPerTruck: r.palletsPerTruck });

/** Every stored ratio, plus parts seen in shipments that have none, with the ratio calculations would use. */
palletRatiosRoutes.get('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const open = isNull(shipments.actualArrivalDate);
  const [stored, parts] = await Promise.all([
    db.select().from(palletRatios),
    db
      .select({
        partNumber: sql<string>`${shipments.partNumber}`,
        commodity: sql<string | null>`max(${shipments.commodity})`,
        description: sql<string | null>`max(${shipments.itemDescription})`,
        openLines: sql<number>`count(*) filter (where ${open})`.mapWith(Number),
        openUnits: sql<number>`coalesce(sum(${shipments.quantity}) filter (where ${open}), 0)`.mapWith(Number),
      })
      .from(shipments)
      .where(isNotNull(shipments.partNumber))
      .groupBy(shipments.partNumber),
  ]);
  const lookup = new RatioLookup(stored);
  const seen = new Map(parts.map((p) => [p.partNumber, p]));
  const keys = [...new Set([...stored.map((r) => r.partNumber), ...seen.keys()])].sort();
  const byPart = new Map(stored.map((r) => [r.partNumber, r]));

  const rows: PalletRatioRow[] = keys.map((partNumber) => {
    const r = byPart.get(partNumber);
    const p = seen.get(partNumber);
    const commodity = p?.commodity ?? r?.productGroup ?? null;
    const resolved = lookup.resolve(partNumber, commodity);
    return {
      partNumber,
      itemName: r?.itemName ?? p?.description ?? null,
      commodity,
      unitsPerPallet: r?.unitsPerPallet ?? null,
      palletsPerTruck: r?.palletsPerTruck ?? null,
      canDoubleStack: r?.canDoubleStack ?? false,
      note: r?.note ?? null,
      source: r?.source ?? null,
      fileValues: r?.fileValues ?? null,
      updatedBy: r?.updatedBy ?? null,
      updatedAt: r?.updatedAt?.toISOString() ?? null,
      basis: resolved.basis,
      effectiveUnitsPerPallet: resolved.unitsPerPallet,
      estimate: resolved.estimate,
      conflict: !!r && r.source === 'manual' && !!r.fileValues && !sameValues(r, r.fileValues),
      openLines: p?.openLines ?? 0,
      openUnits: p?.openUnits ?? 0,
    };
  });
  const body: PalletRatiosResponse = { rows, estimates: lookup.estimates };
  return c.json(body);
});

/** Manual edit; it wins over the file until it's cleared. */
palletRatiosRoutes.put('/:partNumber', async (c) => {
  const partNumber = c.req.param('partNumber').trim();
  const parsed = palletRatioEditSchema.safeParse(await c.req.json());
  if (!partNumber || !parsed.success) return c.json({ error: 'Invalid ratio', issues: parsed.error?.issues }, 400);
  const db = getDb(c.env.DATABASE_URL);
  const { unitsPerPallet, palletsPerTruck, canDoubleStack, note } = parsed.data;
  const set = {
    unitsPerPallet,
    palletsPerTruck,
    ...(canDoubleStack !== undefined && { canDoubleStack }),
    ...(note !== undefined && { note: note?.trim() || null }),
    source: 'manual' as const,
    updatedBy: c.get('userId'),
    updatedAt: new Date(),
  };
  await db.insert(palletRatios).values({ partNumber, ...set }).onConflictDoUpdate({ target: palletRatios.partNumber, set });
  return c.json({ ok: true });
});

/** Drops a manual edit: back to the file's values, or no ratio when the file never had the part. */
palletRatiosRoutes.delete('/:partNumber/manual', async (c) => {
  const partNumber = c.req.param('partNumber');
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db.select().from(palletRatios).where(eq(palletRatios.partNumber, partNumber));
  if (!row) return c.json({ error: 'No ratio for this part' }, 404);
  if (row.source !== 'manual') return c.json({ ok: true });
  if (!row.fileValues) {
    await db.delete(palletRatios).where(eq(palletRatios.partNumber, partNumber));
  } else {
    await db
      .update(palletRatios)
      .set({ ...row.fileValues, source: 'file', updatedBy: c.get('userId'), updatedAt: new Date() })
      .where(eq(palletRatios.partNumber, partNumber));
  }
  return c.json({ ok: true });
});

const fileFieldsChanged = (a: PalletRatioFileRow, b: typeof palletRatios.$inferSelect) =>
  !sameValues(a, b) ||
  a.canDoubleStack !== b.canDoubleStack ||
  a.note !== b.note ||
  a.itemName !== b.itemName ||
  a.productGroup !== b.productGroup;

/**
 * Upload of the Pallet Ratios file (parsed in the browser). File rows are replaced; manual rows
 * keep their values and only record what the file said, reported as conflicts when they differ.
 */
palletRatiosRoutes.post('/import', async (c) => {
  const parsed = palletRatioImportSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid file rows', issues: parsed.error.issues.slice(0, 10) }, 400);
  const dryRun = !!parsed.data.dryRun;
  const incoming = [...new Map(parsed.data.rows.map((r) => [r.partNumber, r])).values()];
  const db = getDb(c.env.DATABASE_URL);
  const existing = new Map((await db.select().from(palletRatios)).map((r) => [r.partNumber, r]));

  const result: PalletRatioImportResult = { dryRun, total: incoming.length, added: 0, changed: 0, unchanged: 0, conflicts: [], missing: 0 };
  const fileRows: PalletRatioFileRow[] = [];
  const manualRows: PalletRatioFileRow[] = [];
  for (const r of incoming) {
    if (!r.unitsPerPallet) result.missing++;
    const prev = existing.get(r.partNumber);
    if (!prev) {
      result.added++;
      fileRows.push(r);
    } else if (prev.source === 'manual') {
      if (!sameValues(prev, r)) result.conflicts.push({ partNumber: r.partNumber, manual: valuesOf(prev), file: valuesOf(r) });
      else result.unchanged++;
      manualRows.push(r);
    } else {
      if (fileFieldsChanged(r, prev)) result.changed++;
      else result.unchanged++;
      fileRows.push(r);
    }
  }
  if (dryRun) return c.json(result);

  const userId = c.get('userId');
  const now = new Date();
  for (const part of chunk(fileRows, 200)) {
    await db
      .insert(palletRatios)
      .values(part.map((r) => ({ ...r, source: 'file' as const, fileValues: valuesOf(r), updatedBy: userId, updatedAt: now })))
      .onConflictDoUpdate({
        target: palletRatios.partNumber,
        set: {
          unitsPerPallet: sql`excluded.units_per_pallet`,
          palletsPerTruck: sql`excluded.pallets_per_truck`,
          canDoubleStack: sql`excluded.can_double_stack`,
          note: sql`excluded.note`,
          itemName: sql`excluded.item_name`,
          productGroup: sql`excluded.product_group`,
          source: sql`excluded.source`,
          fileValues: sql`excluded.file_values`,
          updatedBy: sql`excluded.updated_by`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
  for (const r of manualRows) {
    await db
      .update(palletRatios)
      .set({ fileValues: valuesOf(r), itemName: r.itemName, productGroup: r.productGroup })
      .where(eq(palletRatios.partNumber, r.partNumber));
  }
  return c.json(result);
});
