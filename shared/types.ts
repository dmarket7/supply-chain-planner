import { z } from 'zod';

export const SHIPMENT_STATUSES = [
  'pending',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'unknown',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_MODES = ['parcel', 'ltl'] as const;
export type ShipmentMode = (typeof SHIPMENT_MODES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** One normalized row from an uploaded report, as sent to POST /api/imports. */
export const shipmentInputSchema = z
  .object({
    supplier: z.string().min(1),
    poNumber: z.string().nullish(),
    lineRef: z.string().nullish(),
    itemDescription: z.string().nullish(),
    quantity: z.number().nullish(),
    carrier: z.string().nullish(),
    mode: z.enum(SHIPMENT_MODES).nullish(),
    trackingNumber: z.string().nullish(),
    shipDate: isoDate.nullish(),
    promisedArrivalDate: isoDate,
    actualArrivalDate: isoDate.nullish(),
  })
  .refine((r) => r.trackingNumber || r.poNumber, {
    message: 'Row needs a tracking number or a PO number',
  });
export type ShipmentInput = z.infer<typeof shipmentInputSchema>;

export const importRequestSchema = z.object({
  fileName: z.string().min(1),
  mappingId: z.number().int().nullish(),
  rows: z.array(shipmentInputSchema).min(1).max(5000),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;

export interface ImportResult {
  importId: number;
  inserted: number;
  updated: number;
  promisedDateChanges: number;
}

/** Target fields a spreadsheet column can be mapped to. */
export const TARGET_FIELDS = [
  'supplier',
  'poNumber',
  'lineRef',
  'itemDescription',
  'quantity',
  'carrier',
  'trackingNumber',
  'shipDate',
  'promisedArrivalDate',
  'actualArrivalDate',
] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];

/** Target field -> source column header. */
export type ColumnMapping = Partial<Record<TargetField, string>>;

export interface SavedMapping {
  id: number;
  name: string;
  mapping: ColumnMapping;
  headerSignature: string;
}

export interface Shipment {
  id: number;
  supplier: string;
  poNumber: string | null;
  lineRef: string | null;
  itemDescription: string | null;
  quantity: number | null;
  carrier: string | null;
  mode: ShipmentMode | null;
  trackingNumber: string | null;
  shipDate: string | null;
  promisedArrivalDate: string;
  estimatedArrivalDate: string | null;
  actualArrivalDate: string | null;
  arrivalSource: 'manual' | 'tracking' | 'import' | null;
  status: ShipmentStatus;
  lastTrackedAt: string | null;
}

export interface TrackingEvent {
  id: number;
  occurredAt: string;
  status: ShipmentStatus;
  description: string | null;
  location: string | null;
  provider: string;
}

export interface ShipmentDetail extends Shipment {
  events: TrackingEvent[];
  promisedDateHistory: { previousDate: string; newDate: string; changedAt: string }[];
}

export interface InboundDay {
  date: string;
  total: number;
  byCarrier: Record<string, number>;
  byStatus: Partial<Record<ShipmentStatus, number>>;
  shipments: Shipment[];
}

export interface ArrivalLogEntry extends Shipment {
  /** The supplier's first promised date (before any later reports moved it). */
  originalPromisedDate: string;
  /** actual - originalPromised; positive = late. */
  varianceDays: number;
  onTime: boolean;
}

export interface SupplierScore {
  supplier: string;
  arrivals: number;
  onTime: number;
  onTimePct: number;
  avgVarianceDays: number;
}

export interface ArrivalsResponse {
  entries: ArrivalLogEntry[];
  scorecard: SupplierScore[];
}
