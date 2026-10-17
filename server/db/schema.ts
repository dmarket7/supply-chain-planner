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
import { SHIPMENT_MODES, SHIPMENT_STATUSES, type ColumnMapping } from '../../shared/types';

export const shipmentStatus = pgEnum('shipment_status', SHIPMENT_STATUSES);
export const shipmentMode = pgEnum('shipment_mode', SHIPMENT_MODES);
export const arrivalSource = pgEnum('arrival_source', ['manual', 'tracking', 'import']);

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
  uploadedBy: text('uploaded_by').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
  rowCount: integer('row_count').notNull().default(0),
  inserted: integer('inserted').notNull().default(0),
  updated: integer('updated').notNull().default(0),
  mappingId: integer('mapping_id').references(() => columnMappings.id, { onDelete: 'set null' }),
});

export const suppliers = pgTable('suppliers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
});

export const shipments = pgTable('shipments', {
  id: serial('id').primaryKey(),
  /** `trk:<TRACKING>` or `po:<supplierId>:<PO>:<LINE>`; the upsert key for re-imports. */
  dedupeKey: text('dedupe_key').notNull().unique(),
  supplierId: integer('supplier_id').notNull().references(() => suppliers.id),
  poNumber: text('po_number'),
  lineRef: text('line_ref'),
  itemDescription: text('item_description'),
  quantity: numeric('quantity', { mode: 'number' }),
  carrier: text('carrier'),
  carrierDetected: boolean('carrier_detected').notNull().default(false),
  mode: shipmentMode('mode'),
  trackingNumber: text('tracking_number'),
  shipDate: date('ship_date'),
  promisedArrivalDate: date('promised_arrival_date').notNull(),
  estimatedArrivalDate: date('estimated_arrival_date'),
  actualArrivalDate: date('actual_arrival_date'),
  arrivalSource: arrivalSource('arrival_source'),
  status: shipmentStatus('status').notNull().default('pending'),
  lastTrackedAt: timestamp('last_tracked_at', { withTimezone: true }),
  firstImportId: integer('first_import_id').references(() => imports.id),
  lastImportId: integer('last_import_id').references(() => imports.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('shipments_expected_idx').on(sql`coalesce(${t.estimatedArrivalDate}, ${t.promisedArrivalDate})`),
  index('shipments_actual_idx').on(t.actualArrivalDate),
  index('shipments_status_idx').on(t.status),
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
