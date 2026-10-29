CREATE TABLE "po_line_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"group_key" text NOT NULL,
	"hash" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "po_report_lines" (
	"import_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	CONSTRAINT "po_report_lines_import_id_version_id_pk" PRIMARY KEY("import_id","version_id")
);
--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "lines_stored" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "po_report_lines" ADD CONSTRAINT "po_report_lines_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_report_lines" ADD CONSTRAINT "po_report_lines_version_id_po_line_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."po_line_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "po_line_versions_key_idx" ON "po_line_versions" USING btree ("dedupe_key","hash");--> statement-breakpoint
CREATE INDEX "po_line_versions_group_idx" ON "po_line_versions" USING btree ("group_key");--> statement-breakpoint
CREATE INDEX "po_report_lines_version_idx" ON "po_report_lines" USING btree ("version_id");