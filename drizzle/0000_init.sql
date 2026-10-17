CREATE TYPE "public"."arrival_source" AS ENUM('manual', 'tracking', 'import');--> statement-breakpoint
CREATE TYPE "public"."shipment_mode" AS ENUM('parcel', 'ltl');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('pending', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'unknown');--> statement-breakpoint
CREATE TABLE "column_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"header_signature" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"mapping_id" integer
);
--> statement-breakpoint
CREATE TABLE "promised_date_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"shipment_id" integer NOT NULL,
	"previous_date" date NOT NULL,
	"new_date" date NOT NULL,
	"import_id" integer,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"supplier_id" integer NOT NULL,
	"po_number" text,
	"line_ref" text,
	"item_description" text,
	"quantity" numeric,
	"carrier" text,
	"carrier_detected" boolean DEFAULT false NOT NULL,
	"mode" "shipment_mode",
	"tracking_number" text,
	"ship_date" date,
	"promised_arrival_date" date NOT NULL,
	"estimated_arrival_date" date,
	"actual_arrival_date" date,
	"arrival_source" "arrival_source",
	"status" "shipment_status" DEFAULT 'pending' NOT NULL,
	"last_tracked_at" timestamp with time zone,
	"first_import_id" integer,
	"last_import_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "suppliers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "tracking_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"shipment_id" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" "shipment_status" NOT NULL,
	"description" text,
	"location" text,
	"provider" text NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_mapping_id_column_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."column_mappings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promised_date_history" ADD CONSTRAINT "promised_date_history_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promised_date_history" ADD CONSTRAINT "promised_date_history_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_first_import_id_imports_id_fk" FOREIGN KEY ("first_import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_last_import_id_imports_id_fk" FOREIGN KEY ("last_import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "column_mappings_signature_idx" ON "column_mappings" USING btree ("header_signature");--> statement-breakpoint
CREATE INDEX "promised_date_history_shipment_idx" ON "promised_date_history" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipments_expected_idx" ON "shipments" USING btree (coalesce("estimated_arrival_date", "promised_arrival_date"));--> statement-breakpoint
CREATE INDEX "shipments_actual_idx" ON "shipments" USING btree ("actual_arrival_date");--> statement-breakpoint
CREATE INDEX "shipments_status_idx" ON "shipments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tracking_events_shipment_idx" ON "tracking_events" USING btree ("shipment_id","occurred_at");