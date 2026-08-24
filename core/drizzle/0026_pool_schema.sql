CREATE TABLE "member_pool_guilds" (
	"pool_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "member_pool_guilds_pool_id_guild_id_pk" PRIMARY KEY("pool_id","guild_id")
);
--> statement-breakpoint
CREATE TABLE "member_pools" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text,
	"billed_tier" text,
	"status" text DEFAULT 'active' NOT NULL,
	"grace_until" timestamp with time zone,
	"member_count" integer,
	"member_count_updated_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_notifications" ALTER COLUMN "guild_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_notifications" ADD COLUMN "pool_id" text;--> statement-breakpoint
ALTER TABLE "guilds" ADD COLUMN "pool_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "member_pool_guilds_live_guild_idx" ON "member_pool_guilds" USING btree ("guild_id") WHERE removed_at is null;--> statement-breakpoint
CREATE INDEX "member_pool_guilds_pool_idx" ON "member_pool_guilds" USING btree ("pool_id","removed_at");--> statement-breakpoint
CREATE INDEX "member_pools_owner_idx" ON "member_pools" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_notifications_pool_pending_key" ON "billing_notifications" USING btree ("pool_id","key") WHERE delivered_at IS NULL;--> statement-breakpoint
CREATE INDEX "billing_notifications_pool_idx" ON "billing_notifications" USING btree ("pool_id","enqueued_at");