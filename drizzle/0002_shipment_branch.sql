ALTER TABLE "shipments" ADD COLUMN "branch" text;--> statement-breakpoint
CREATE INDEX "shipments_branch_idx" ON "shipments" USING btree ("branch");--> statement-breakpoint
-- Backfill from the stored spreadsheet row (Meerkat "Supplier POs" tab has a Branch column).
UPDATE "shipments" SET "branch" = nullif(trim("source_row"->>'Branch'), '') WHERE "branch" IS NULL AND "source_row"->>'Branch' IS NOT NULL;
