/**
 * Pallet conversions. A part's units per pallet comes from, best first:
 *  1. a manual entry in Settings, or the uploaded Pallet Ratios file (`real`)
 *  2. the median of the real ratios in the part's commodity (`estimated`)
 *  3. nothing: the commodity has no real ratios either (`none`, units only)
 *
 * Pallets are kept fractional (pallet-equivalents), so partial pallets that may be combined with
 * other items show up as fractions; the whole pallets in each line are counted separately.
 */

export const PALLET_BASES = ['real', 'estimated', 'none'] as const;
export type PalletBasis = (typeof PALLET_BASES)[number];

export const RATIO_SOURCES = ['file', 'manual'] as const;
export type RatioSource = (typeof RATIO_SOURCES)[number];

/** The values the file gave a part, kept even after a manual edit so later uploads can be compared. */
export interface RatioValues {
  unitsPerPallet: number | null;
  palletsPerTruck: number | null;
}

export interface PalletRatio extends RatioValues {
  partNumber: string;
  productGroup: string | null;
  source: RatioSource;
}

export interface CommodityEstimate {
  commodity: string;
  /** Median of the real ratios in this commodity. */
  unitsPerPallet: number;
  palletsPerTruck: number | null;
  /** How many parts with a real ratio the median is based on. */
  parts: number;
  min: number;
  max: number;
  /** Real ratios differ by 10x or more, so the estimate is weak. */
  wideSpread: boolean;
}

export interface ResolvedRatio {
  basis: PalletBasis;
  unitsPerPallet: number | null;
  palletsPerTruck: number | null;
  /** For estimates: the commodity and how many parts its median is based on. */
  estimate?: { commodity: string; parts: number };
}

export interface LinePallets extends ResolvedRatio {
  /** null when there is no ratio. */
  palletEq: number | null;
  fullPallets: number;
  partial: boolean;
}

export interface PalletSummary {
  lines: number;
  units: number;
  palletEq: number;
  realPalletEq: number;
  estimatedPalletEq: number;
  /** Whole pallets: each line's units ÷ units per pallet, rounded down. */
  fullPallets: number;
  /** Lines with a remainder, i.e. a pallet that isn't full (and may be combined with others). */
  partialPallets: number;
  estimatedLines: number;
  noRatioLines: number;
  noRatioUnits: number;
}

const EPS = 1e-9;

/** Commodity names differ in case between the report and the file (THERMAL vs Thermal). */
export function commodityKey(commodity: string | null | undefined): string | null {
  const k = commodity?.trim().toUpperCase();
  return k ? k : null;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function commodityEstimates(ratios: PalletRatio[]): CommodityEstimate[] {
  const groups = new Map<string, { name: string; units: number[]; trucks: number[] }>();
  for (const r of ratios) {
    const key = commodityKey(r.productGroup);
    if (!key || !r.unitsPerPallet) continue;
    const g = groups.get(key) ?? { name: r.productGroup!.trim(), units: [], trucks: [] };
    g.units.push(r.unitsPerPallet);
    if (r.palletsPerTruck) g.trucks.push(r.palletsPerTruck);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => {
      const min = Math.min(...g.units);
      const max = Math.max(...g.units);
      return {
        commodity: g.name,
        unitsPerPallet: median(g.units),
        palletsPerTruck: g.trucks.length ? median(g.trucks) : null,
        parts: g.units.length,
        min,
        max,
        wideSpread: max >= min * 10,
      };
    })
    .sort((a, b) => a.commodity.localeCompare(b.commodity));
}

export class RatioLookup {
  readonly estimates: CommodityEstimate[];
  private byPart: Map<string, PalletRatio>;
  private byCommodity: Map<string, CommodityEstimate>;

  constructor(ratios: PalletRatio[]) {
    this.byPart = new Map(ratios.map((r) => [r.partNumber, r]));
    this.estimates = commodityEstimates(ratios);
    this.byCommodity = new Map(this.estimates.map((e) => [commodityKey(e.commodity)!, e]));
  }

  /** The report's commodity is used for the estimate, falling back to the file's product group. */
  resolve(partNumber: string | null | undefined, commodity: string | null | undefined): ResolvedRatio {
    const own = partNumber ? this.byPart.get(partNumber) : undefined;
    if (own?.unitsPerPallet) {
      return { basis: 'real', unitsPerPallet: own.unitsPerPallet, palletsPerTruck: own.palletsPerTruck };
    }
    const key = commodityKey(commodity) ?? commodityKey(own?.productGroup);
    const est = key ? this.byCommodity.get(key) : undefined;
    if (!est) return { basis: 'none', unitsPerPallet: null, palletsPerTruck: own?.palletsPerTruck ?? null };
    return {
      basis: 'estimated',
      unitsPerPallet: est.unitsPerPallet,
      // A part can have a known pallets-per-truck without a units-per-pallet.
      palletsPerTruck: own?.palletsPerTruck ?? est.palletsPerTruck,
      estimate: { commodity: est.commodity, parts: est.parts },
    };
  }

  line(partNumber: string | null | undefined, commodity: string | null | undefined, quantity: number | null | undefined): LinePallets {
    return toPallets(this.resolve(partNumber, commodity), quantity ?? 0);
  }
}

export function toPallets(ratio: ResolvedRatio, quantity: number): LinePallets {
  if (!ratio.unitsPerPallet) return { ...ratio, palletEq: null, fullPallets: 0, partial: false };
  const palletEq = Math.max(quantity, 0) / ratio.unitsPerPallet;
  const fullPallets = Math.floor(palletEq + EPS);
  return { ...ratio, palletEq, fullPallets, partial: palletEq - fullPallets > EPS };
}

export function emptySummary(): PalletSummary {
  return {
    lines: 0,
    units: 0,
    palletEq: 0,
    realPalletEq: 0,
    estimatedPalletEq: 0,
    fullPallets: 0,
    partialPallets: 0,
    estimatedLines: 0,
    noRatioLines: 0,
    noRatioUnits: 0,
  };
}

/** Adds one line to a running summary (mutates `sum`). */
export function addLine(sum: PalletSummary, p: LinePallets, quantity: number | null | undefined): PalletSummary {
  const units = quantity ?? 0;
  sum.lines++;
  sum.units += units;
  if (p.palletEq === null) {
    sum.noRatioLines++;
    sum.noRatioUnits += units;
    return sum;
  }
  sum.palletEq += p.palletEq;
  if (p.basis === 'estimated') {
    sum.estimatedPalletEq += p.palletEq;
    sum.estimatedLines++;
  } else {
    sum.realPalletEq += p.palletEq;
  }
  sum.fullPallets += p.fullPallets;
  if (p.partial) sum.partialPallets++;
  return sum;
}

export function mergeSummaries(items: PalletSummary[]): PalletSummary {
  const out = emptySummary();
  for (const s of items) for (const k of Object.keys(out) as (keyof PalletSummary)[]) out[k] += s[k];
  return out;
}

/** Share of pallet-equivalents that come from estimates, 0–1. */
export function estimatedShare(s: PalletSummary): number {
  return s.palletEq > 0 ? s.estimatedPalletEq / s.palletEq : 0;
}
