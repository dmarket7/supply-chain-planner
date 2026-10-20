CREATE TABLE "line_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"shipment_id" integer NOT NULL,
	"import_id" integer,
	"report_date" date NOT NULL,
	"kind" text NOT NULL,
	"from_value" text,
	"to_value" text
);
--> statement-breakpoint
ALTER TABLE "line_changes" ADD CONSTRAINT "line_changes_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_changes" ADD CONSTRAINT "line_changes_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "line_changes_shipment_idx" ON "line_changes" USING btree ("shipment_id","report_date");--> statement-breakpoint
CREATE INDEX "line_changes_import_idx" ON "line_changes" USING btree ("import_id");--> statement-breakpoint
-- Remove carrier-tracking (Ship24) data; until per-carrier APIs exist, everything comes from the uploads.
DELETE FROM "tracking_events";--> statement-breakpoint
UPDATE "shipments" SET "tracking_run_id" = NULL WHERE "tracking_run_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "tracking_runs";--> statement-breakpoint
-- Arrivals confirmed by tracking go back to the report-based estimate (same rules as planRow):
-- closed after being seen open -> within (last open report, first report showing it closed]; closed when
-- first seen -> the supplier ETA; still open -> not arrived.
UPDATE "shipments" s SET
  "actual_arrival_date" = CASE
    WHEN c.closed_on IS NOT NULL THEN least(greatest(coalesce(s."promised_arrival_date", c.closed_on), s."last_seen_open_report_date" + 1), c.closed_on)
    WHEN s."po_status" = 'closed' THEN s."promised_arrival_date"
  END,
  "arrival_source" = CASE
    WHEN c.closed_on IS NOT NULL THEN 'report_window'::arrival_source
    WHEN s."po_status" = 'closed' AND s."promised_arrival_date" IS NOT NULL THEN 'eta'::arrival_source
  END,
  "arrival_window_start" = CASE WHEN c.closed_on IS NOT NULL THEN s."last_seen_open_report_date" + 1 END,
  "arrival_window_end" = c.closed_on
FROM (
  SELECT sh."id",
    CASE WHEN sh."po_status" = 'closed' AND sh."last_seen_open_report_date" IS NOT NULL THEN (
      SELECT min(i."report_date") FROM "imports" i
      WHERE i."completed_at" IS NOT NULL AND i."report_date" > sh."last_seen_open_report_date"
    ) END AS closed_on
  FROM "shipments" sh WHERE sh."arrival_source" = 'tracking'
) c
WHERE c."id" = s."id";--> statement-breakpoint
UPDATE "shipments" SET "status" = (CASE
    WHEN "asn" IS NOT NULL OR "tracking_number" IS NOT NULL THEN 'in_transit'
    WHEN "promised_arrival_date" IS NOT NULL THEN 'pending'
    ELSE 'awaiting_shipment'
  END)::shipment_status
WHERE "actual_arrival_date" IS NULL AND "po_status" IS DISTINCT FROM 'closed'
  AND ("last_tracked_at" IS NOT NULL OR "status" IN ('out_for_delivery', 'exception', 'unknown', 'delivered'));--> statement-breakpoint
UPDATE "shipments" SET
  "estimated_arrival_date" = NULL, "last_tracked_at" = NULL, "tracking_provider" = NULL, "tracking_found" = NULL,
  "tracked_carrier" = NULL, "tracking_changed_at" = NULL, "last_event_at" = NULL
WHERE "last_tracked_at" IS NOT NULL OR "estimated_arrival_date" IS NOT NULL OR "tracking_found" IS NOT NULL;--> statement-breakpoint
-- Backfill progress from what earlier uploads left behind: when each line was first listed (and in
-- what state), when it closed, and supplier ETA changes.
INSERT INTO "line_changes" ("shipment_id", "import_id", "report_date", "kind", "to_value")
SELECT s."id", i."id", i."report_date", 'new',
  CASE
    WHEN s."po_status" = 'closed' AND s."last_seen_open_report_date" IS NULL THEN 'delivered'
    WHEN s."asn" IS NOT NULL OR s."tracking_number" IS NOT NULL THEN 'in_transit'
    WHEN s."status" = 'awaiting_shipment' THEN 'awaiting_shipment'
    ELSE 'pending'
  END
FROM "shipments" s JOIN "imports" i ON i."id" = s."first_import_id";--> statement-breakpoint
INSERT INTO "line_changes" ("shipment_id", "import_id", "report_date", "kind", "to_value")
SELECT s."id",
  (SELECT min(i."id") FROM "imports" i WHERE i."report_date" = s."arrival_window_end" AND i."completed_at" IS NOT NULL),
  s."arrival_window_end", 'closed', s."actual_arrival_date"::text
FROM "shipments" s WHERE s."arrival_source" = 'report_window' AND s."arrival_window_end" IS NOT NULL;--> statement-breakpoint
INSERT INTO "line_changes" ("shipment_id", "import_id", "report_date", "kind", "from_value", "to_value")
SELECT h."shipment_id", h."import_id", coalesce(i."report_date", h."changed_at"::date), 'eta_changed', h."previous_date"::text, h."new_date"::text
FROM "promised_date_history" h LEFT JOIN "imports" i ON i."id" = h."import_id";
