import { ORDER_CHANGE_KINDS, type OrderChangeCause, type OrderChangeKind, type OrderChangeSummary, type OrderLineState } from './orderChanges';
import type { CommodityEstimate, LinePallets, PalletBasis, PalletSummary, RatioSource, RatioValues, TruckSummary } from './pallets';
import type { ProgressCounts } from './progress';
import type { OrderSupply, PartSupply, Readiness } from './supply';
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
  /** An older report (or a same-date re-upload): the client rebuilds the PO history next. */
  needsRebuild: boolean;
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
  /** User-confirmed provider courier code for this line (overrides the carrier mapping). */
  courierOverride: string | null;
  /** Registration (provider_trackings row) this line is linked to. */
  trackingRegistrationId: number | null;
  /** Filled in by the API: how this line is tracked. */
  tracking?: LineTracking;
}

/**
 * Lifecycle of a tracking number registered with a provider that needs registration (TrackingMore):
 * - registering: claimed by a request that is sending it now (guards against double registration)
 * - awaiting_data: registered; the carrier has not returned any scans yet (normal for the first hours)
 * - active: the provider returns tracking data
 * - unavailable: still no data long after registration (wrong courier or number not in the carrier's system)
 * - expired: the provider stopped tracking it (no updates for a long time)
 * - invalid: the provider rejected the number or courier code
 * - register_failed: registration did not go through (temporary error, quota); can be retried
 * - missing: the provider no longer has it (deleted on their side); can be registered again
 * - conflict: the provider already tracks an earlier shipment with this reused number
 */
export const REGISTRATION_STATES = [
  'registering',
  'awaiting_data',
  'active',
  'unavailable',
  'expired',
  'invalid',
  'register_failed',
  'missing',
  'conflict',
] as const;
export type RegistrationState = (typeof REGISTRATION_STATES)[number];

/** How a line is (or isn't) tracked, as shown in the UI. */
export const TRACKING_LABELS = [
  'no_tracking',
  'direct',
  'unresolved',
  'unsupported',
  'not_registered',
  'awaiting_data',
  'active',
  'unavailable',
  'expired',
  'api_error',
] as const;
export type TrackingLabel = (typeof TRACKING_LABELS)[number];

export interface TrackingRegistrationInfo {
  id: number;
  provider: string;
  courierCode: string;
  state: RegistrationState;
  registeredAt: string | null;
  lastSyncedAt: string | null;
  lastSuccessAt: string | null;
  lastProviderStatus: string | null;
  lastProviderSubstatus: string | null;
  latestEvent: string | null;
  latestCheckpointAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastWarning: string | null;
}

/** Tracking route of one line: which provider handles it and with which courier. */
export interface LineTracking {
  label: TrackingLabel;
  /** fedex (direct) or trackingmore; null when no provider handles the line. */
  provider: string | null;
  courierCode: string | null;
  courierName: string | null;
  /** Where the courier code came from: a per-line override or the carrier mapping. */
  courierSource: 'override' | 'mapping' | null;
  /** Why the line can't be tracked, for unresolved/unsupported lines. */
  reason: string | null;
  registration: TrackingRegistrationInfo | null;
}

/** One carrier (or generic carrier + reference prefix) in the coverage view. */
export interface CoverageRow {
  carrier: string;
  prefix: string;
  label: string;
  lines: number;
  openLines: number;
  numbers: number;
  registeredLines: number;
  overrideLines: number;
  /** Distinct registrations linked to these lines (a courier change unlinks them; re-registering uses credits). */
  registrations: number;
  /** Registrations still without any scan long after registering: the courier may be wrong. */
  stalledRegistrations: number;
  /** A tracking number from these lines (open ones first), for TrackingMore's courier detection. */
  sampleNumber: string | null;
  /** direct = own carrier API (FedEx); mapped = TrackingMore courier confirmed; unsupported; unresolved. */
  route: 'direct' | 'mapped' | 'unsupported' | 'unresolved';
  provider: string | null;
  courierCode: string | null;
  courierName: string | null;
  reason: string | null;
  candidates: { courierCode: string; name: string }[];
  suggested: string | null;
  ambiguous: boolean;
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

export interface InboundShipment extends Shipment {
  pallets: LinePallets;
}

export interface InboundDay {
  date: string;
  total: number;
  byCarrier: Record<string, number>;
  byStatus: Partial<Record<ShipmentStatus, number>>;
  pallets: PalletSummary;
  shipments: InboundShipment[];
}

/** Inbound lines in a date range, grouped by part. */
export interface InboundPart {
  partNumber: string | null;
  description: string | null;
  commodity: string | null;
  basis: PalletBasis;
  unitsPerPallet: number | null;
  estimate?: { commodity: string; parts: number };
  pallets: PalletSummary;
}

export interface InboundResponse {
  from: string;
  to: string;
  days: InboundDay[];
  parts: InboundPart[];
}

/** One part on the Pallet ratios settings page: a stored ratio and/or a part seen in shipments. */
export interface PalletRatioRow {
  partNumber: string;
  itemName: string | null;
  commodity: string | null;
  unitsPerPallet: number | null;
  palletsPerTruck: number | null;
  canDoubleStack: boolean;
  note: string | null;
  /** null = no stored ratio (the part only appears in shipments). */
  source: RatioSource | null;
  fileValues: RatioValues | null;
  updatedBy: string | null;
  updatedAt: string | null;
  basis: PalletBasis;
  /** The ratio used for calculations: the part's own, or its commodity estimate. */
  effectiveUnitsPerPallet: number | null;
  estimate?: { commodity: string; parts: number };
  /** A manual edit differs from what the latest upload said. */
  conflict: boolean;
  /** Open inbound lines (not yet arrived) and their units. */
  openLines: number;
  openUnits: number;
  /** Open sales orders in the current ODM Open Order snapshot and their units. */
  outboundOrders: number;
  outboundUnits: number;
}

export interface PalletRatiosResponse {
  rows: PalletRatioRow[];
  estimates: CommodityEstimate[];
}

const ratioNumber = z.number().positive().nullable();

export const palletRatioEditSchema = z.object({
  unitsPerPallet: ratioNumber,
  palletsPerTruck: ratioNumber,
  canDoubleStack: z.boolean().optional(),
  note: z.string().nullish(),
});
export type PalletRatioEdit = z.infer<typeof palletRatioEditSchema>;

export const palletRatioFileRowSchema = z.object({
  partNumber: z.string().trim().min(1),
  unitsPerPallet: ratioNumber,
  palletsPerTruck: ratioNumber,
  canDoubleStack: z.boolean(),
  note: z.string().nullable(),
  itemName: z.string().nullable(),
  productGroup: z.string().nullable(),
});
export type PalletRatioFileRow = z.infer<typeof palletRatioFileRowSchema>;

export const palletRatioImportSchema = z.object({
  rows: z.array(palletRatioFileRowSchema).min(1).max(5000),
  dryRun: z.boolean().optional(),
});

export interface PalletRatioImportResult {
  dryRun: boolean;
  total: number;
  added: number;
  changed: number;
  unchanged: number;
  /** Parts with a manual edit that the file disagrees with; the manual value is kept. */
  conflicts: { partNumber: string; manual: RatioValues; file: RatioValues }[];
  /** Rows in the file with no units per pallet. */
  missing: number;
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

/* ---------- Outbound (ODM Open Order) ---------- */

export const OUTBOUND_CHUNK_SIZE = 500;

const nullableText = z.string().nullable();
const nullableDate = isoDate.nullable();

/** One sales order line read from the ODM Open Order tab, after summing its reservation pieces. */
export const outboundOrderInputSchema = z.object({
  soNumber: z.string().min(1),
  emsPo: nullableText,
  status: nullableText,
  warehouse: nullableText,
  shipTo: nullableText,
  cpn: nullableText,
  mpn: nullableText,
  manufacturer: nullableText,
  businessGroup: nullableText,
  packagingType: nullableText,
  quantity: z.number().nonnegative(),
  totalPrice: z.number().nullable(),
  sourceRows: z.number().int().positive(),
  shipDate: nullableDate,
  shipDateSource: z.enum(['confirmed', 'scheduled']).nullable(),
  scheduledShipDate: nullableDate,
  confirmedShipDate: nullableDate,
  dockDate: nullableDate,
  /** Older clients don't send it. */
  originalRequestDate: nullableDate.default(null),
  poReceiptDate: nullableDate,
});
export type OutboundOrderInput = z.infer<typeof outboundOrderInputSchema>;

export const startOutboundSchema = z.object({
  fileName: z.string().min(1),
  reportDate: isoDate,
  rowCount: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  skippedQuotations: z.number().int().nonnegative(),
});

export const outboundOrdersChunkSchema = z.object({
  orders: z.array(outboundOrderInputSchema).min(1).max(OUTBOUND_CHUNK_SIZE),
});

/** How the current snapshot differs from the one before it, by Wintec SO#. */
export interface OutboundChanges {
  previousReportDate: string;
  /** SOs in the previous report that are gone: shipped or cancelled. */
  noLongerListed: number;
  added: number;
  quantityChanged: number;
  /** Per SO# + CPN, from the stored changes. */
  summary: OrderChangeSummary;
}

export interface OutboundSnapshotInfo {
  id: number;
  fileName: string;
  reportDate: string;
  rowCount: number;
  orderCount: number;
  skippedQuotations: number;
  changes: OutboundChanges | null;
}

export interface OutboundOrder extends OutboundOrderInput {
  id: number;
  /** From the Pallet Ratios file, when the part is in it. */
  itemName: string | null;
  pallets: LinePallets;
  /** Null until an Inventory Summary has been imported. */
  supply: OrderSupply | null;
  /** What changed on this SO# + CPN since the previous report. */
  changes: OrderChangeRow[];
}

export interface OrderChangeRow {
  kind: OrderChangeKind;
  from: string | null;
  to: string | null;
  causes: OrderChangeCause[];
}

export interface OrderNote {
  id: number;
  reportDate: string;
  kind: OrderChangeKind;
  note: string;
  author: string;
  createdAt: string;
  mine: boolean;
}

export const orderNoteSchema = z.object({
  soNumber: z.string().min(1),
  cpn: z.string().nullable(),
  reportDate: isoDate,
  kind: z.enum(ORDER_CHANGE_KINDS),
  note: z.string().trim().min(1).max(1000),
});

/** One SO# + CPN across every kept report. */
export interface OrderHistoryResponse {
  soNumber: string;
  cpn: string | null;
  /** Oldest first; `line` is null when the report didn't list it. */
  reports: { reportDate: string; line: OrderLineState | null }[];
  changes: (OrderChangeRow & { reportDate: string; previousReportDate: string })[];
  notes: OrderNote[];
}

/** One report date on the Import page's history. */
export interface ImportHistoryRow {
  reportDate: string;
  /** `linesStored` false: imported before reports could be added out of order, so it can't be replayed. */
  inbound: { importId: number; fileName: string; counts: ProgressCounts; linesStored: boolean } | null;
  outbound: { snapshotId: number; orderCount: number; summary: OrderChangeSummary | null } | null;
  /** Parts per site whose available stock went up or down since the previous inventory; null for the first. */
  inventory: { snapshotId: number; positionCount: number; up: number | null; down: number | null } | null;
}

export interface ReadinessTotals {
  orders: number;
  units: number;
  palletEq: number;
}

export interface OutboundDay {
  date: string;
  orders: number;
  pallets: PalletSummary;
  /** Orders to the same ship-to on this day share trucks. */
  trucks: TruckSummary;
  readiness: Partial<Record<Readiness, ReadinessTotals>>;
}

/** One part (MPN) going to one ship-to. */
export interface OutboundPart {
  mpn: string | null;
  cpn: string | null;
  itemName: string | null;
  businessGroup: string | null;
  basis: PalletBasis;
  unitsPerPallet: number | null;
  estimate?: { commodity: string; parts: number };
  orders: number;
  pallets: PalletSummary;
  /** Units per reservation status. */
  unitsByStatus: Record<string, number>;
  nextShipDate: string | null;
}

export interface OutboundShipTo {
  shipTo: string;
  orders: number;
  pallets: PalletSummary;
  trucks: TruckSummary;
  readiness: Partial<Record<Readiness, ReadinessTotals>>;
  nextShipDate: string | null;
  parts: OutboundPart[];
  lines: OutboundOrder[];
}

export interface OutboundBacklog {
  orders: number;
  pallets: PalletSummary;
  trucks: TruckSummary;
  readiness: Partial<Record<Readiness, ReadinessTotals>>;
}

export interface OutboundResponse {
  from: string;
  to: string;
  snapshot: OutboundSnapshotInfo | null;
  /** Report date of the inventory the readiness is based on; null = not imported yet. */
  inventoryReportDate: string | null;
  days: OutboundDay[];
  shipTos: OutboundShipTo[];
  /** Whole snapshot, outside the date range: ship date before the report date, still listed as open. */
  overdue: OutboundBacklog;
  /** Whole snapshot: no ship date (blank or a 2099 placeholder). */
  unscheduled: OutboundBacklog;
}

export const INVENTORY_CHUNK_SIZE = 500;

/** Stock of one part in one branch, summed over the open receipt lots of the Inventory Summary tab. */
export const inventoryPositionInputSchema = z.object({
  partNumber: z.string().min(1),
  branch: z.string().min(1),
  vendorPn: nullableText,
  description: nullableText,
  commodity: nullableText,
  onhand: z.number(),
  reserved: z.number(),
  allocated: z.number(),
  available: z.number(),
  onReceipt: z.number(),
  oldestReceiptDate: nullableDate,
  sourceRows: z.number().int().positive(),
});
export type InventoryPositionInput = z.infer<typeof inventoryPositionInputSchema>;

export const startInventorySchema = z.object({
  fileName: z.string().min(1),
  reportDate: isoDate,
  rowCount: z.number().int().nonnegative(),
  positionCount: z.number().int().nonnegative(),
});

export const inventoryPositionsChunkSchema = z.object({
  positions: z.array(inventoryPositionInputSchema).min(1).max(INVENTORY_CHUNK_SIZE),
});

export interface InventorySnapshotInfo {
  id: number;
  fileName: string;
  reportDate: string;
  rowCount: number;
  positionCount: number;
}

export interface SupplyOrderRow {
  id: number;
  /** Null until an Inventory Summary has been imported. */
  readiness: Readiness | null;
  coveredBy: string | null;
  supplierShipDate: string | null;
  shortUnits: number;
  soNumber: string;
  shipTo: string | null;
  cpn: string | null;
  mpn: string | null;
  status: string | null;
  quantity: number;
  shipDate: string | null;
}

export interface SupplyInboundRow {
  id: number;
  supplier: string;
  poNumber: string | null;
  lineRef: string | null;
  branch: string | null;
  quantity: number | null;
  eta: string | null;
  status: ShipmentStatus;
}

export interface SupplyPartRow extends PartSupply {
  mpn: string | null;
  /** Available now minus at the previous inventory report; null when there is none. */
  availableChange: number | null;
  orderRows: SupplyOrderRow[];
  inbound: SupplyInboundRow[];
}

export interface SupplyResponse {
  inventory: InventorySnapshotInfo | null;
  outboundReportDate: string | null;
  parts: SupplyPartRow[];
}

export interface DashboardTop {
  name: string;
  palletEq: number;
  units: number;
  count: number;
}

/** One column of the dashboard flow chart: before today, then four weeks from today. */
export interface DashboardBucket {
  key: string;
  /** Null for the "before today" bucket. */
  from: string | null;
  to: string;
  inbound: { lines: number; pallets: PalletSummary; topSuppliers: DashboardTop[] };
  outbound: OutboundBacklog & { topShipTos: DashboardTop[] };
}

export interface DashboardInboundRow {
  id: number;
  supplier: string;
  poNumber: string | null;
  lineRef: string | null;
  partNumber: string | null;
  quantity: number | null;
  eta: string;
}

export interface DashboardShortPart {
  partNumber: string;
  site: string;
  description: string | null;
  shortUnits: number;
  firstShortDate: string | null;
  orders: number;
}

export interface DashboardResponse {
  asOf: { purchaseOrders: string | null; outbound: string | null; inventory: string | null };
  buckets: DashboardBucket[];
  exceptions: {
    /** Late or short, shipping in the next 14 days (or already due). */
    atRisk: { count: number; units: number; rows: SupplyOrderRow[] };
    /** Ship date before the outbound report date, still open. */
    overdue: { count: number; byReadiness: Partial<Record<Readiness, number>>; rows: SupplyOrderRow[] };
    /** Expected date passed, not arrived. */
    lateInbound: { count: number; rows: DashboardInboundRow[] };
    shortParts: { count: number; units: number; rows: DashboardShortPart[] };
    dataGaps: {
      palletEq: number;
      estimatedPalletEq: number;
      noRatioLines: number;
      noRatioUnits: number;
      /** Open orders relying on inbound lines the supplier hasn't given an ETA for. */
      noEtaOrders: number;
      noEtaUnits: number;
    };
  };
}
