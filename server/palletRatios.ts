import { RatioLookup } from '../shared/pallets';
import type { Db } from './db/client';
import { palletRatios } from './db/schema';

export async function loadRatioLookup(db: Db): Promise<RatioLookup> {
  const rows = await db
    .select({
      partNumber: palletRatios.partNumber,
      unitsPerPallet: palletRatios.unitsPerPallet,
      palletsPerTruck: palletRatios.palletsPerTruck,
      productGroup: palletRatios.productGroup,
      source: palletRatios.source,
    })
    .from(palletRatios);
  return new RatioLookup(rows);
}
