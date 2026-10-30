CREATE TABLE "po_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"po_number" text NOT NULL,
	"po_line" text NOT NULL,
	"branch" text NOT NULL,
	"part_number" text,
	"receipt_date" date NOT NULL,
	"arrived_date" date,
	"quantity" numeric,
	"last_report_date" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "so_shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"ship_to" text,
	"odm_po" text,
	"odm_po_line" text,
	"part_number" text,
	"branch" text,
	"wintec_po" text,
	"quantity" numeric,
	"ship_date" date NOT NULL,
	"so_etd" date,
	"so_eta" date,
	"receipt_date" date,
	"tracking" text,
	"first_report_date" date NOT NULL,
	CONSTRAINT "so_shipments_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "po_receipts_lot_idx" ON "po_receipts" USING btree ("po_number","po_line","branch","receipt_date");--> statement-breakpoint
CREATE INDEX "so_shipments_order_idx" ON "so_shipments" USING btree ("odm_po","part_number");--> statement-breakpoint
CREATE INDEX "so_shipments_date_idx" ON "so_shipments" USING btree ("ship_date");