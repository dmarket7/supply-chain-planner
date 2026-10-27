CREATE TABLE "inventory_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"part_number" text NOT NULL,
	"branch" text NOT NULL,
	"vendor_pn" text,
	"description" text,
	"commodity" text,
	"onhand" numeric NOT NULL,
	"reserved" numeric NOT NULL,
	"allocated" numeric NOT NULL,
	"available" numeric NOT NULL,
	"on_receipt" numeric NOT NULL,
	"oldest_receipt_date" date,
	"source_rows" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"report_date" date NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"row_count" integer DEFAULT 0 NOT NULL,
	"position_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_positions" ADD CONSTRAINT "inventory_positions_snapshot_id_inventory_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."inventory_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_positions_part_idx" ON "inventory_positions" USING btree ("snapshot_id","part_number","branch");--> statement-breakpoint
CREATE INDEX "inventory_snapshots_report_idx" ON "inventory_snapshots" USING btree ("report_date");