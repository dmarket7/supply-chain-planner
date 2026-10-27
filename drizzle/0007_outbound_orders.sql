CREATE TABLE "outbound_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"so_number" text NOT NULL,
	"ems_po" text,
	"status" text,
	"warehouse" text,
	"ship_to" text,
	"cpn" text,
	"mpn" text,
	"manufacturer" text,
	"business_group" text,
	"packaging_type" text,
	"quantity" numeric NOT NULL,
	"total_price" numeric,
	"source_rows" integer DEFAULT 1 NOT NULL,
	"ship_date" date,
	"ship_date_source" text,
	"scheduled_ship_date" date,
	"confirmed_ship_date" date,
	"dock_date" date,
	"po_receipt_date" date
);
--> statement-breakpoint
CREATE TABLE "outbound_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"report_date" date NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"row_count" integer DEFAULT 0 NOT NULL,
	"order_count" integer DEFAULT 0 NOT NULL,
	"skipped_quotations" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbound_orders" ADD CONSTRAINT "outbound_orders_snapshot_id_outbound_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."outbound_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_orders_ship_date_idx" ON "outbound_orders" USING btree ("snapshot_id","ship_date");--> statement-breakpoint
CREATE INDEX "outbound_orders_cpn_idx" ON "outbound_orders" USING btree ("snapshot_id","cpn");--> statement-breakpoint
CREATE INDEX "outbound_snapshots_report_idx" ON "outbound_snapshots" USING btree ("report_date");