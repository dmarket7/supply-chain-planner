CREATE TYPE "public"."po_status" AS ENUM('open', 'closed');--> statement-breakpoint
ALTER TYPE "public"."arrival_source" ADD VALUE 'report_window';--> statement-breakpoint
ALTER TYPE "public"."arrival_source" ADD VALUE 'eta';--> statement-breakpoint
ALTER TYPE "public"."shipment_status" ADD VALUE 'awaiting_shipment' BEFORE 'pending';--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "mode" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."shipment_mode";--> statement-breakpoint
CREATE TYPE "public"."shipment_mode" AS ENUM('parcel', 'freight');--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "mode" SET DATA TYPE "public"."shipment_mode" USING (CASE WHEN "mode" = 'ltl' THEN 'freight' ELSE "mode" END)::"public"."shipment_mode";--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "promised_arrival_date" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "sheet_name" text;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "report_date" date;--> statement-breakpoint
UPDATE "imports" SET "report_date" = "uploaded_at"::date WHERE "report_date" IS NULL;--> statement-breakpoint
ALTER TABLE "imports" ALTER COLUMN "report_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "imports" SET "completed_at" = "uploaded_at";--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "promised_date_changes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "newly_closed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "removed_awaiting" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "asn" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "po_status" "po_status";--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "customer_po" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "part_number" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "commodity" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "warehouse" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracking_ref" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "request_date" date;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "arrival_window_start" date;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "arrival_window_end" date;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "last_seen_open_report_date" date;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "source_row" jsonb;--> statement-breakpoint
CREATE INDEX "shipments_tracking_idx" ON "shipments" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "shipments_po_idx" ON "shipments" USING btree ("po_number","line_ref");