CREATE TABLE "order_change_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"so_number" text NOT NULL,
	"cpn" text,
	"report_date" date NOT NULL,
	"kind" text NOT NULL,
	"note" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"report_date" date NOT NULL,
	"previous_report_date" date NOT NULL,
	"so_number" text NOT NULL,
	"cpn" text,
	"ship_to" text,
	"warehouse" text,
	"kind" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"causes" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbound_orders" ADD COLUMN "original_request_date" date;--> statement-breakpoint
ALTER TABLE "outbound_changes" ADD CONSTRAINT "outbound_changes_snapshot_id_outbound_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."outbound_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_change_notes_line_idx" ON "order_change_notes" USING btree ("so_number","cpn");--> statement-breakpoint
CREATE INDEX "outbound_changes_line_idx" ON "outbound_changes" USING btree ("so_number","cpn");--> statement-breakpoint
CREATE INDEX "outbound_changes_snapshot_idx" ON "outbound_changes" USING btree ("snapshot_id");