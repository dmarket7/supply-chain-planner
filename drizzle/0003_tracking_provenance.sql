CREATE TABLE "tracking_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_by" text NOT NULL,
	"scope" text NOT NULL,
	"branch" text,
	"provider" text,
	"batches" integer DEFAULT 0 NOT NULL,
	"checked" integer DEFAULT 0 NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"not_found" integer DEFAULT 0 NOT NULL,
	"lines_updated" integer DEFAULT 0 NOT NULL,
	"lines_changed" integer DEFAULT 0 NOT NULL,
	"arrivals_confirmed" integer DEFAULT 0 NOT NULL,
	"ignored_deliveries" integer DEFAULT 0 NOT NULL,
	"remaining" integer DEFAULT 0 NOT NULL,
	"rate_limited" boolean DEFAULT false NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracking_provider" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracking_found" boolean;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracked_carrier" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracking_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracking_run_id" integer;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "arrival_set_by" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "arrival_set_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tracking_runs_started_idx" ON "tracking_runs" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tracking_run_id_tracking_runs_id_fk" FOREIGN KEY ("tracking_run_id") REFERENCES "public"."tracking_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill lines already looked up before this migration: those with scans were found by the provider.
UPDATE "shipments" s SET
  "tracking_found" = e.n > 0,
  "tracking_provider" = e.provider,
  "last_event_at" = e.last_at,
  "tracking_changed_at" = CASE WHEN e.n > 0 THEN s."last_tracked_at" END
FROM (
  SELECT sh."id", count(te."id")::int AS n, min(te."provider") AS provider, max(te."occurred_at") AS last_at
  FROM "shipments" sh LEFT JOIN "tracking_events" te ON te."shipment_id" = sh."id"
  WHERE sh."last_tracked_at" IS NOT NULL
  GROUP BY sh."id"
) e
WHERE s."id" = e."id";--> statement-breakpoint
UPDATE "shipments" SET "arrival_set_at" = "updated_at" WHERE "arrival_source" = 'manual' AND "actual_arrival_date" IS NOT NULL;
