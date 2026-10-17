import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { TARGET_FIELDS } from '../../shared/types';
import { getDb } from '../db/client';
import { columnMappings } from '../db/schema';
import type { AppEnv } from '../env';

export const mappingsRoutes = new Hono<AppEnv>();

const mappingSchema = z.object({
  name: z.string().min(1),
  headerSignature: z.string().min(1),
  mapping: z.partialRecord(z.enum(TARGET_FIELDS), z.string()),
});

mappingsRoutes.get('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select({
      id: columnMappings.id,
      name: columnMappings.name,
      mapping: columnMappings.mapping,
      headerSignature: columnMappings.headerSignature,
    })
    .from(columnMappings)
    .orderBy(desc(columnMappings.createdAt));
  return c.json(rows);
});

mappingsRoutes.post('/', async (c) => {
  const parsed = mappingSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid mapping', issues: parsed.error.issues }, 400);
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .insert(columnMappings)
    .values({ ...parsed.data, createdBy: c.get('userId') })
    .returning({ id: columnMappings.id });
  return c.json(row, 201);
});

mappingsRoutes.delete('/:id', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  await db.delete(columnMappings).where(eq(columnMappings.id, Number(c.req.param('id'))));
  return c.json({ ok: true });
});
