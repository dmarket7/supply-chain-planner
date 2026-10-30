import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
  primaryKey,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { OrderChangeCause, OrderChangeKind } from '../../shared/orderChanges';
import type { RatioSource, RatioValues } from '../../shared/pallets';
import { ARRIVAL_SOURCES, PO_STATUSES, SHIPMENT_MODES, SHIPMENT_STATUSES, type ColumnMapping, type LineChangeKind, type RegistrationState } from '../../shared/types';

export const shipmentStatus = pgEnum('shipment_status', SHIPMENT_STATUSES);
export const shipmentMode = pgEnum('shipment_mode', SHIPMENT_MODES);
export const arrivalSource = pgEnum('arrival_source', ARRIVAL_SOURCES);
export const poStatus = pgEnum('po_status', PO_STATUSES);

export const columnMappings = pgTable('column_mappings', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  mapping: jsonb('mapping').$type<ColumnMapping>().notNull(),
  headerSignature: text('header_signature').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('column_mappings_signature_idx').on(t.headerSignature)]);

export const imports = pgTable('imports', {
  id: serial('id').primaryKey(),
  fileName: text('file_name').notNull(),
  sheetName: text('sheet_name'),
  /** Date the report was run (not uploaded); arrival windows are measured between report dates. */
  reportDate: date('report_date').notNull(),
  /** Set when every chunk has been written and the snapshot clean-up has run. */
  completedAt: timestamp('completed_at', { withTimezone: true }),
  uploadedBy: text('uploaded_by').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
  rowCount: integer('row_count').notNull().default(0),
  inserted: integer('inserted').notNull().default(0),
  updated: integer('updated').notNull().default(0),
  promisedDateChanges: integer('promised_date_changes').notNull().default(0),
  newlyClosed: integer('newly_closed').notNull().default(0),
  removedAwaiting: integer('removed_awaiting').notNull().default(0),
  mappingId: integer('mapping_id').references(() => columnMappings.id, { onDelete: 'set null' }),
  /** The report's rows are kept (po_report_lines), so the PO history can be rebuilt from it. */
  linesStored: boolean('lines_stored').notNull().default(false),
  /** Set when the report is deleted; the row goes once the history has been rebuilt without it. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

/**
 * One version of one PO line as a report listed it. A line that doesn't change between reports
 * keeps one version, so keeping every report stays small.
 */
export const poLineVersions = pgTable('po_line_versions', {
  id: serial('id').primaryKey(),
  dedupeKey: text('dedupe_key').notNull(),
  /** PO number (or the line's key when it has none): lines of one PO are replayed together. */
  groupKey: text('group_key').notNull(),
  hash: text('hash').notNull(),
  data: jsonb('data').notNull(),
}, (t) => [uniqueIndex('po_line_versions_key_idx').on(t.dedupeKey, t.hash), index('po_line_versions_group_idx').on(t.groupKey)]);

/** Which line versions each Supplier PO report listed. */
export const poReportLines = pgTable('po_report_lines', {
  importId: integer('import_id').notNull().references(() => imports.id, { onDelete: 'cascade' }),
  versionId: integer('version_id').notNull().references(() => poLineVersions.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.importId, t.versionId] }), index('po_report_lines_version_idx').on(t.versionId)]);

export const suppliers = pgTable('suppliers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
});

/** One click of "Refresh tracking" (or a cron run): totals across all of its batches. */
export const trackingRuns = pgTable('tracking_runs', {
  id: serial('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  startedBy: text('started_by').notNull(),
  /** open | estimated | line */
  scope: text('scope').notNull(),
  branch: text('branch'),
  provider: text('provider'),
  batches: integer('batches').notNull().default(0),
  checked: integer('checked').notNull().default(0),
  found: integer('found').notNull().default(0),
  notFound: integer('not_found').notNull().default(0),
  linesUpdated: integer('lines_updated').notNull().default(0),
  linesChanged: integer('lines_changed').notNull().default(0),
  arrivalsConfirmed: integer('arrivals_confirmed').notNull().default(0),
  ignoredDeliveries: integer('ignored_deliveries').notNull().default(0),
  remaining: integer('remaining').notNull().default(0),
  rateLimited: boolean('rate_limited').notNull().default(false),
  error: text('error'),
}, (t) => [index('tracking_runs_started_idx').on(t.startedAt)]);

/** A registration provider's courier list (TrackingMore /couriers/all), synced on demand. */
export const providerCouriers = pgTable('provider_couriers', {
  provider: text('provider').notNull(),
  courierCode: text('courier_code').notNull(),
  name: text('name').notNull(),
  countryIso2: text('country_iso2'),
  type: text('type'),
  url: text('url'),
  requiredFields: jsonb('required_fields'),
  syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.provider, t.courierCode] })]);

/**
 * User-confirmed mapping from an app carrier (plus, for generic carriers like "Forwarder", a reference
 * prefix such as "CWF") to a provider courier code, or a decision that the provider can't track it.
 */
export const carrierMappings = pgTable('carrier_mappings', {
  id: serial('id').primaryKey(),
  provider: text('provider').notNull(),
  carrier: text('carrier').notNull(),
  prefix: text('prefix').notNull().default(''),
  courierCode: text('courier_code'),
  status: text('status').$type<'mapped' | 'unsupported'>().notNull(),
  confirmedBy: text('confirmed_by').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique('carrier_mappings_key').on(t.provider, t.carrier, t.prefix)]);

/**
 * One tracking identity registered with a provider that needs registration (TrackingMore).
 * Identity = provider + courier + number + episode: the same number can belong to different couriers,
 * and carriers reuse numbers, so a shipment months later is a new episode (keyed by its ship date).
 * PO lines point at their registration through shipments.tracking_registration_id.
 */
export const providerTrackings = pgTable('provider_trackings', {
  id: serial('id').primaryKey(),
  provider: text('provider').notNull(),
  courierCode: text('courier_code').notNull(),
  trackingNumber: text('tracking_number').notNull(),
  /** Earliest ship date of the episode (YYYY-MM-DD), or `none` when the lines had no ship date. */
  episodeKey: text('episode_key').notNull(),
  anchorShipDate: date('anchor_ship_date'),
  /** The provider's own id for the tracking (TrackingMore `id`), when returned. */
  externalId: text('external_id'),
  state: text('state').$type<RegistrationState>().notNull(),
  /** When a request claimed the row to register it; a stale claim can be retried. */
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  registeredAt: timestamp('registered_at', { withTimezone: true }),
  registeredBy: text('registered_by'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastProviderStatus: text('last_provider_status'),
  lastProviderSubstatus: text('last_provider_substatus'),
  latestEvent: text('latest_event'),
  latestCheckpointAt: timestamp('latest_checkpoint_at', { withTimezone: true }),
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  lastWarning: text('last_warning'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique('provider_trackings_identity').on(t.provider, t.courierCode, t.trackingNumber, t.episodeKey),
  index('provider_trackings_state_idx').on(t.state),
]);

export const shipments = pgTable('shipments', {
  id: serial('id').primaryKey(),
  /** `po:<PO>:<LINE>:<ASN>` (or `trk:<TRACKING>` when a report has no PO); the upsert key for re-imports. */
  dedupeKey: text('dedupe_key').notNull().unique(),
  supplierId: integer('supplier_id').notNull().references(() => suppliers.id),
  poNumber: text('po_number'),
  lineRef: text('line_ref'),
  asn: text('asn'),
  poStatus: poStatus('po_status'),
  customerPo: text('customer_po'),
  partNumber: text('part_number'),
  itemDescription: text('item_description'),
  commodity: text('commodity'),
  branch: text('branch'),
  warehouse: text('warehouse'),
  quantity: numeric('quantity', { mode: 'number' }),
  carrier: text('carrier'),
  carrierDetected: boolean('carrier_detected').notNull().default(false),
  mode: shipmentMode('mode'),
  trackingNumber: text('tracking_number'),
  trackingRef: text('tracking_ref'),
  requestDate: date('request_date'),
  shipDate: date('ship_date'),
  promisedArrivalDate: date('promised_arrival_date'),
  estimatedArrivalDate: date('estimated_arrival_date'),
  actualArrivalDate: date('actual_arrival_date'),
  arrivalSource: arrivalSource('arrival_source'),
  arrivalWindowStart: date('arrival_window_start'),
  arrivalWindowEnd: date('arrival_window_end'),
  /** Report date of the latest import that listed this line as Open. */
  lastSeenOpenReportDate: date('last_seen_open_report_date'),
  status: shipmentStatus('status').notNull().default('pending'),
  lastTrackedAt: timestamp('last_tracked_at', { withTimezone: true }),
  /** Provider that last looked this line up, e.g. `fedex`. */
  trackingProvider: text('tracking_provider'),
  /** null = never checked; false = provider had no data; true = provider returned tracking. */
  trackingFound: boolean('tracking_found'),
  /** Carrier as identified by the provider. */
  trackedCarrier: text('tracked_carrier'),
  /** Last time a lookup actually changed status, ETA, arrival or added scans. */
  trackingChangedAt: timestamp('tracking_changed_at', { withTimezone: true }),
  /** Run that made that last change. */
  trackingRunId: integer('tracking_run_id').references(() => trackingRuns.id, { onDelete: 'set null' }),
  /** Time of the newest carrier scan. */
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  /** Who entered a manual arrival, and when. */
  arrivalSetBy: text('arrival_set_by'),
  arrivalSetAt: timestamp('arrival_set_at', { withTimezone: true }),
  /** User-confirmed provider courier code for this line, when the carrier can't be mapped reliably. */
  courierOverride: text('courier_override'),
  courierOverrideBy: text('courier_override_by'),
  courierOverrideAt: timestamp('courier_override_at', { withTimezone: true }),
  /** Registration this line's tracking number belongs to (provider_trackings). */
  trackingRegistrationId: integer('tracking_registration_id').references(() => providerTrackings.id, { onDelete: 'set null' }),
  firstImportId: integer('first_import_id').references(() => imports.id),
  lastImportId: integer('last_import_id').references(() => imports.id),
  /** The spreadsheet row as last imported, so unmapped columns are available later. */
  sourceRow: jsonb('source_row'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('shipments_expected_idx').on(sql`coalesce(${t.estimatedArrivalDate}, ${t.promisedArrivalDate})`),
  index('shipments_actual_idx').on(t.actualArrivalDate),
  index('shipments_status_idx').on(t.status),
  index('shipments_branch_idx').on(t.branch),
  index('shipments_tracking_idx').on(t.trackingNumber),
  index('shipments_po_idx').on(t.poNumber, t.lineRef),
  index('shipments_registration_idx').on(t.trackingRegistrationId),
]);

export const trackingEvents = pgTable('tracking_events', {
  id: serial('id').primaryKey(),
  shipmentId: integer('shipment_id').notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  status: shipmentStatus('status').notNull(),
  description: text('description'),
  location: text('location'),
  provider: text('provider').notNull(),
  raw: jsonb('raw'),
  /** Stable identity (time + status + description + location) so repeated syncs never duplicate events. */
  eventKey: text('event_key'),
}, (t) => [
  index('tracking_events_shipment_idx').on(t.shipmentId, t.occurredAt),
  uniqueIndex('tracking_events_identity').on(t.shipmentId, t.provider, t.eventKey),
]);

/**
 * What one upload changed on one line (see LINE_CHANGE_KINDS), so a line's progress can be followed
 * from report to report. from/to hold the old and new value (dates as YYYY-MM-DD, statuses as enum values).
 */
export const lineChanges = pgTable('line_changes', {
  id: serial('id').primaryKey(),
  shipmentId: integer('shipment_id').notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  importId: integer('import_id').references(() => imports.id, { onDelete: 'set null' }),
  reportDate: date('report_date').notNull(),
  kind: text('kind').$type<LineChangeKind>().notNull(),
  fromValue: text('from_value'),
  toValue: text('to_value'),
}, (t) => [
  index('line_changes_shipment_idx').on(t.shipmentId, t.reportDate),
  index('line_changes_import_idx').on(t.importId),
]);

export const promisedDateHistory = pgTable('promised_date_history', {
  id: serial('id').primaryKey(),
  shipmentId: integer('shipment_id').notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  previousDate: date('previous_date').notNull(),
  newDate: date('new_date').notNull(),
  importId: integer('import_id').references(() => imports.id),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('promised_date_history_shipment_idx').on(t.shipmentId)]);

/**
 * Units per pallet and pallets per truck for one part (Wintec PN / CPN), from the uploaded
 * Pallet Ratios file or entered in Settings. Parts without a row get a commodity estimate.
 */
export const palletRatios = pgTable('pallet_ratios', {
  partNumber: text('part_number').primaryKey(),
  unitsPerPallet: numeric('units_per_pallet', { mode: 'number' }),
  palletsPerTruck: numeric('pallets_per_truck', { mode: 'number' }),
  canDoubleStack: boolean('can_double_stack').notNull().default(false),
  itemName: text('item_name'),
  productGroup: text('product_group'),
  note: text('note'),
  source: text('source').$type<RatioSource>().notNull(),
  /** What the latest upload said, kept under a manual edit so a later upload can flag a disagreement. */
  fileValues: jsonb('file_values').$type<RatioValues>(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** One upload of the report's ODM Open Order tab. The latest completed one (by report date) is current. */
export const outboundSnapshots = pgTable('outbound_snapshots', {
  id: serial('id').primaryKey(),
  fileName: text('file_name').notNull(),
  reportDate: date('report_date').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  rowCount: integer('row_count').notNull().default(0),
  orderCount: integer('order_count').notNull().default(0),
  skippedQuotations: integer('skipped_quotations').notNull().default(0),
}, (t) => [index('outbound_snapshots_report_idx').on(t.reportDate)]);

/**
 * One open sales order line from a snapshot. The report splits an order into reservation pieces
 * (often identical rows); these are summed into one row per SO, status, part, ship-to and ship date.
 */
export const outboundOrders = pgTable('outbound_orders', {
  id: serial('id').primaryKey(),
  snapshotId: integer('snapshot_id').notNull().references(() => outboundSnapshots.id, { onDelete: 'cascade' }),
  soNumber: text('so_number').notNull(),
  emsPo: text('ems_po'),
  /** Reservation status: Reserved Physical / Reserved ordered / On order. */
  status: text('status'),
  warehouse: text('warehouse'),
  shipTo: text('ship_to'),
  cpn: text('cpn'),
  mpn: text('mpn'),
  manufacturer: text('manufacturer'),
  businessGroup: text('business_group'),
  packagingType: text('packaging_type'),
  quantity: numeric('quantity', { mode: 'number' }).notNull(),
  totalPrice: numeric('total_price', { mode: 'number' }),
  sourceRows: integer('source_rows').notNull().default(1),
  /** Wintec confirmed ship date, else the system schedule date; null = unscheduled (blank or a 2099 placeholder). */
  shipDate: date('ship_date'),
  shipDateSource: text('ship_date_source').$type<'confirmed' | 'scheduled'>(),
  scheduledShipDate: date('scheduled_ship_date'),
  confirmedShipDate: date('confirmed_ship_date'),
  /** EMS Requested Dock Date: when the customer wants it. */
  dockDate: date('dock_date'),
  /** The report's "Origianl Requested Date". */
  originalRequestDate: date('original_request_date'),
  poReceiptDate: date('po_receipt_date'),
}, (t) => [
  index('outbound_orders_ship_date_idx').on(t.snapshotId, t.shipDate),
  index('outbound_orders_cpn_idx').on(t.snapshotId, t.cpn),
]);

/** One uploaded Inventory Summary tab. The latest completed one by report date is current. */
export const inventorySnapshots = pgTable('inventory_snapshots', {
  id: serial('id').primaryKey(),
  fileName: text('file_name').notNull(),
  reportDate: date('report_date').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  rowCount: integer('row_count').notNull().default(0),
  positionCount: integer('position_count').notNull().default(0),
}, (t) => [index('inventory_snapshots_report_idx').on(t.reportDate)]);

/** Stock of one part in one branch, summed over its open receipt lots. */
export const inventoryPositions = pgTable('inventory_positions', {
  id: serial('id').primaryKey(),
  snapshotId: integer('snapshot_id').notNull().references(() => inventorySnapshots.id, { onDelete: 'cascade' }),
  partNumber: text('part_number').notNull(),
  branch: text('branch').notNull(),
  vendorPn: text('vendor_pn'),
  description: text('description'),
  commodity: text('commodity'),
  onhand: numeric('onhand', { mode: 'number' }).notNull(),
  reserved: numeric('reserved', { mode: 'number' }).notNull(),
  allocated: numeric('allocated', { mode: 'number' }).notNull(),
  /** Free to reserve for ODM orders; can be negative on one side of a transfer between branches. */
  available: numeric('available', { mode: 'number' }).notNull(),
  /** Still open with the supplier. */
  onReceipt: numeric('on_receipt', { mode: 'number' }).notNull(),
  oldestReceiptDate: date('oldest_receipt_date'),
  sourceRows: integer('source_rows').notNull().default(1),
}, (t) => [uniqueIndex('inventory_positions_part_idx').on(t.snapshotId, t.partNumber, t.branch)]);

/**
 * What changed on one sales order line (SO# + CPN) in a snapshot compared with the previous one.
 * Recomputed when a snapshot completes, and for the next newer one, so out-of-order imports stay right.
 */
export const outboundChanges = pgTable('outbound_changes', {
  id: serial('id').primaryKey(),
  snapshotId: integer('snapshot_id').notNull().references(() => outboundSnapshots.id, { onDelete: 'cascade' }),
  reportDate: date('report_date').notNull(),
  previousReportDate: date('previous_report_date').notNull(),
  soNumber: text('so_number').notNull(),
  cpn: text('cpn'),
  shipTo: text('ship_to'),
  warehouse: text('warehouse'),
  kind: text('kind').$type<OrderChangeKind>().notNull(),
  fromValue: text('from_value'),
  toValue: text('to_value'),
  causes: jsonb('causes').$type<OrderChangeCause[]>().notNull().default([]),
}, (t) => [
  index('outbound_changes_line_idx').on(t.soNumber, t.cpn),
  index('outbound_changes_snapshot_idx').on(t.snapshotId),
]);

/** A team note on why an order line changed. Keyed by line, report date and kind so it survives a re-import. */
export const orderChangeNotes = pgTable('order_change_notes', {
  id: serial('id').primaryKey(),
  soNumber: text('so_number').notNull(),
  cpn: text('cpn'),
  reportDate: date('report_date').notNull(),
  kind: text('kind').$type<OrderChangeKind>().notNull(),
  note: text('note').notNull(),
  createdBy: text('created_by').notNull(),
  createdByLabel: text('created_by_label'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('order_change_notes_line_idx').on(t.soNumber, t.cpn)]);

/**
 * One receipt of a PO line at a branch, from the Inventory Summary tab (one row per received lot).
 * Receipts are facts: every upload adds the lots it lists and none are removed.
 */
export const poReceipts = pgTable('po_receipts', {
  id: serial('id').primaryKey(),
  poNumber: text('po_number').notNull(),
  /** The Inventory Summary's line number; a Supplier POs line "1-2" is delivery 2 of line 1. */
  poLine: text('po_line').notNull(),
  branch: text('branch').notNull(),
  partNumber: text('part_number'),
  /** MaterialRecDate: received at Wintec. */
  receiptDate: date('receipt_date').notNull(),
  /** Actual_ReceiveDate: arrived at this branch (later than the receipt for stock moved to quarantine). */
  arrivedDate: date('arrived_date'),
  quantity: numeric('quantity', { mode: 'number' }),
  lastReportDate: date('last_report_date').notNull(),
}, (t) => [uniqueIndex('po_receipts_lot_idx').on(t.poNumber, t.poLine, t.branch, t.receiptDate)]);

/** One sales order line Wintec shipped, from the Transactions tab. Each report repeats past shipments. */
export const soShipments = pgTable('so_shipments', {
  id: serial('id').primaryKey(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  /** The ODM (ship-to). */
  shipTo: text('ship_to'),
  /** Matches the ODM Open Order tab's EMS PO#. */
  odmPo: text('odm_po'),
  odmPoLine: text('odm_po_line'),
  partNumber: text('part_number'),
  branch: text('branch'),
  wintecPo: text('wintec_po'),
  quantity: numeric('quantity', { mode: 'number' }),
  shipDate: date('ship_date').notNull(),
  soEtd: date('so_etd'),
  soEta: date('so_eta'),
  /** Receipt of the stock it shipped from. */
  receiptDate: date('receipt_date'),
  tracking: text('tracking'),
  firstReportDate: date('first_report_date').notNull(),
}, (t) => [index('so_shipments_order_idx').on(t.odmPo, t.partNumber), index('so_shipments_date_idx').on(t.shipDate)]);
