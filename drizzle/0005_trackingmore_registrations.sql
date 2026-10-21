CREATE TABLE "carrier_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"carrier" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"courier_code" text,
	"status" text NOT NULL,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carrier_mappings_key" UNIQUE("provider","carrier","prefix")
);
--> statement-breakpoint
CREATE TABLE "provider_couriers" (
	"provider" text NOT NULL,
	"courier_code" text NOT NULL,
	"name" text NOT NULL,
	"country_iso2" text,
	"type" text,
	"url" text,
	"required_fields" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_couriers_provider_courier_code_pk" PRIMARY KEY("provider","courier_code")
);
--> statement-breakpoint
CREATE TABLE "provider_trackings" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"courier_code" text NOT NULL,
	"tracking_number" text NOT NULL,
	"episode_key" text NOT NULL,
	"anchor_ship_date" date,
	"external_id" text,
	"state" text NOT NULL,
	"claimed_at" timestamp with time zone,
	"registered_at" timestamp with time zone,
	"registered_by" text,
	"last_synced_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_provider_status" text,
	"last_provider_substatus" text,
	"latest_event" text,
	"latest_checkpoint_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"last_warning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_trackings_identity" UNIQUE("provider","courier_code","tracking_number","episode_key")
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "courier_override" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "courier_override_by" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "courier_override_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracking_registration_id" integer;--> statement-breakpoint
ALTER TABLE "tracking_events" ADD COLUMN "event_key" text;--> statement-breakpoint
CREATE INDEX "provider_trackings_state_idx" ON "provider_trackings" USING btree ("state");--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tracking_registration_id_provider_trackings_id_fk" FOREIGN KEY ("tracking_registration_id") REFERENCES "public"."provider_trackings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipments_registration_idx" ON "shipments" USING btree ("tracking_registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracking_events_identity" ON "tracking_events" USING btree ("shipment_id","provider","event_key");