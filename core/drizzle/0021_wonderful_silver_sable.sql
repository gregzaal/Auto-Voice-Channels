CREATE TABLE "alerts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"fleet" text DEFAULT 'prod' NOT NULL,
	"key" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"audience" text DEFAULT 'hosted' NOT NULL,
	"severity" text DEFAULT 'warn' NOT NULL,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_key" ON "alerts" USING btree ("fleet","key","target") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "alerts_undelivered_idx" ON "alerts" USING btree ("opened_at") WHERE delivered_at IS NULL;--> statement-breakpoint
CREATE INDEX "alerts_recent_idx" ON "alerts" USING btree ("opened_at");