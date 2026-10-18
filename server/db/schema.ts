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
} from 'drizzle-orm/pg-core';
import { ARRIVAL_SOURCES, PO_STATUSES, SHIPMENT_MODES, SHIPMENT_STATUSES, type ColumnMapping } from '../../shared/types';

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
  index('shipments_tracking_idx').on(t.trackingNumber),
  index('shipments_po_idx').on(t.poNumber, t.lineRef),
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
}, (t) => [index('tracking_events_shipment_idx').on(t.shipmentId, t.occurredAt)]);

export const promisedDateHistory = pgTable('promised_date_history', {
  id: serial('id').primaryKey(),
  shipmentId: integer('shipment_id').notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  previousDate: date('previous_date').notNull(),
  newDate: date('new_date').notNull(),
  importId: integer('import_id').references(() => imports.id),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('promised_date_history_shipment_idx').on(t.shipmentId)]);
