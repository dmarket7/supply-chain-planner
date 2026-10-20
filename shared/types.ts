import type { ProgressCounts } from './progress';
import { z } from 'zod';

export const SHIPMENT_STATUSES = [
  'awaiting_shipment',
  'pending',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'unknown',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_MODES = ['parcel', 'freight'] as const;
export type ShipmentMode = (typeof SHIPMENT_MODES)[number];

/**
 * Where an actual arrival date came from. `tracking` and `manual` are confirmed;
 * `report_window` and `eta` are estimates that tracking data replaces when it arrives.
 */
export const ARRIVAL_SOURCES = ['manual', 'tracking', 'import', 'report_window', 'eta'] as const;
export type ArrivalSource = (typeof ARRIVAL_SOURCES)[number];
export const ESTIMATED_ARRIVAL_SOURCES: readonly ArrivalSource[] = ['report_window', 'eta'];

export const PO_STATUSES = ['open', 'closed'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const shipmentFields = z.object({
    supplier: z.string().min(1),
    poNumber: z.string().nullish(),
    lineRef: z.string().nullish(),
    /** Delivery / ASN number. One PO line can ship in several deliveries. */
    asn: z.string().nullish(),
    poStatus: z.enum(PO_STATUSES).nullish(),
    customerPo: z.string().nullish(),
    partNumber: z.string().nullish(),
    itemDescription: z.string().nullish(),
    commodity: z.string().nullish(),
    /** ERP branch / warehouse ID, e.g. JIT-MSUS-META. Used to segment every report. */
    branch: z.string().nullish(),
    warehouse: z.string().nullish(),
    quantity: z.number().nullish(),
    carrier: z.string().nullish(),
    mode: z.enum(SHIPMENT_MODES).nullish(),
    trackingNumber: z.string().nullish(),
    /** Secondary reference that came in the tracking cell (e.g. the "IS…" half of "HKG…/IS…"). */
    trackingRef: z.string().nullish(),
    requestDate: isoDate.nullish(),
    shipDate: isoDate.nullish(),
    promisedArrivalDate: isoDate.nullish(),
    actualArrivalDate: isoDate.nullish(),
    /** The original spreadsheet row, kept so other columns can be used later. */
    sourceRow: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullish(),
});
const needsIdentity = [
  (r: { trackingNumber?: string | null; poNumber?: string | null }) => !!(r.trackingNumber || r.poNumber),
  { message: 'Row needs a tracking number or a PO number' },
] as const;

/** One normalized PO line / delivery from an uploaded report. */
export const shipmentInputSchema = shipmentFields.refine(...needsIdentity);
export type ShipmentInput = z.infer<typeof shipmentInputSchema>;

/** A row as uploaded: the shipment plus its key, computed over the whole file (see importKeys.ts). */
export const importRowSchema = shipmentFields.extend({ dedupeKey: z.string().min(1).max(400) }).refine(...needsIdentity);

export const startImportSchema = z.object({
  fileName: z.string().min(1),
  sheetName: z.string().nullish(),
  /** Date the report was run; used to infer arrival windows between uploads. */
  reportDate: isoDate,
  mappingId: z.number().int().nullish(),
  rowCount: z.number().int().nonnegative(),
});
export type StartImportRequest = z.infer<typeof startImportSchema>;

// Small enough that parsing + validating a chunk stays inside the Workers free-plan CPU budget.
export const IMPORT_CHUNK_SIZE = 200;
export const importRowsSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(IMPORT_CHUNK_SIZE),
});

export interface ImportResult {
  importId: number;
  inserted: number;
  updated: number;
  promisedDateChanges: number;
  /** Lines that went from Open to Closed since an earlier report. */
  newlyClosed: number;
  /** "Awaiting shipment" lines from earlier reports that are no longer in this one. */
  removedAwaiting: number;
  /** Lines per kind of progress since the previous report. */
  progress: ProgressCounts;
  previousReportDate: string | null;
}

/** Target fields a spreadsheet column can be mapped to. */
export const TARGET_FIELDS = [
  'supplier',
  'poNumber',
  'lineRef',
  'asn',
  'poStatus',
  'trackingNumber',
  'carrier',
  'promisedArrivalDate',
  'shipDate',
  'requestDate',
  'actualArrivalDate',
  'customerPo',
  'partNumber',
  'itemDescription',
  'commodity',
  'branch',
  'warehouse',
  'quantity',
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
  asn: string | null;
  poStatus: PoStatus | null;
  customerPo: string | null;
  partNumber: string | null;
  itemDescription: string | null;
  commodity: string | null;
  branch: string | null;
  warehouse: string | null;
  quantity: number | null;
  carrier: string | null;
  mode: ShipmentMode | null;
  trackingNumber: string | null;
  trackingRef: string | null;
  requestDate: string | null;
  shipDate: string | null;
  promisedArrivalDate: string | null;
  estimatedArrivalDate: string | null;
  actualArrivalDate: string | null;
  arrivalSource: ArrivalSource | null;
  /** For `report_window` arrivals: the line arrived within [start, end]. */
  arrivalWindowStart: string | null;
  arrivalWindowEnd: string | null;
  status: ShipmentStatus;
  lastTrackedAt: string | null;
  trackingProvider: string | null;
  /** null = never checked; false = the provider had no data; true = tracking found. */
  trackingFound: boolean | null;
  trackedCarrier: string | null;
  /** Last time a lookup changed status, ETA, arrival or added scans. */
  trackingChangedAt: string | null;
  trackingRunId: number | null;
  lastEventAt: string | null;
  arrivalSetBy: string | null;
  arrivalSetAt: string | null;
  /** Changes made by the most recent upload that changed this line. */
  latestChange: { importId: number | null; reportDate: string; changes: LineChange[] } | null;
}

export interface TrackingRun {
  id: number;
  startedAt: string;
  updatedAt: string;
  startedBy: string;
  scope: string;
  branch: string | null;
  provider: string | null;
  batches: number;
  checked: number;
  found: number;
  notFound: number;
  linesUpdated: number;
  linesChanged: number;
  arrivalsConfirmed: number;
  ignoredDeliveries: number;
  remaining: number;
  rateLimited: boolean;
  error: string | null;
}

/**
 * What an upload can change on a line, compared with the previous upload:
 * - new: first listed (to = status it was listed with)
 * - shipped: listed with an ASN where the previous report had the PO line awaiting shipment
 * - eta_changed / ship_date_changed: supplier ETA or ETD moved (from -> to)
 * - tracking_added / tracking_changed: tracking number appeared or changed
 * - closed: PO line closed, i.e. received (to = estimated arrival date)
 * - reopened: closed line listed as open again
 */
export const LINE_CHANGE_KINDS = [
  'new',
  'shipped',
  'eta_changed',
  'ship_date_changed',
  'tracking_added',
  'tracking_changed',
  'closed',
  'reopened',
] as const;
export type LineChangeKind = (typeof LINE_CHANGE_KINDS)[number];

export interface LineChange {
  kind: LineChangeKind;
  from: string | null;
  to: string | null;
}

export interface LineChangeEntry extends LineChange {
  importId: number | null;
  reportDate: string;
}

export interface ProgressSummary {
  importId: number;
  reportDate: string;
  fileName: string;
  /** null when the latest upload is the first one. */
  previousReportDate: string | null;
  counts: ProgressCounts;
  /** Awaiting-shipment lines the latest report no longer lists; null when filtered by branch. */
  removedAwaiting: number | null;
}

export interface BranchSummary {
  branch: string;
  lines: number;
  awaitingShipment: number;
  /** Not arrived and has an expected date. */
  inbound: number;
  dueToday: number;
  next7Days: number;
  pastDue: number;
  arrivedLast30Days: number;
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
  /** Every upload's changes to this line, oldest first. */
  progress: LineChangeEntry[];
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
