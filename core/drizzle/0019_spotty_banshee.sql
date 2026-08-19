CREATE TABLE "billing_notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "billing_notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"notification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"fleet" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_until" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_notifications_pending_key" ON "billing_notifications" USING btree ("guild_id","key") WHERE delivered_at IS NULL;--> statement-breakpoint
CREATE INDEX "billing_notifications_pending_idx" ON "billing_notifications" USING btree ("delivered_at","claimed_until","expires_at","enqueued_at");--> statement-breakpoint
CREATE INDEX "billing_notifications_guild_idx" ON "billing_notifications" USING btree ("guild_id","enqueued_at");