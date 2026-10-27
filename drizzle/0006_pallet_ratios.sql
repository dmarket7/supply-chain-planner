CREATE TABLE "pallet_ratios" (
	"part_number" text PRIMARY KEY NOT NULL,
	"units_per_pallet" numeric,
	"pallets_per_truck" numeric,
	"can_double_stack" boolean DEFAULT false NOT NULL,
	"item_name" text,
	"product_group" text,
	"note" text,
	"source" text NOT NULL,
	"file_values" jsonb,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
