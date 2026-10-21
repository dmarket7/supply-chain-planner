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
});

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
