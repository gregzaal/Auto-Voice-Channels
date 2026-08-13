CREATE TABLE "legacy_customers" (
	"discord_user_id" text PRIMARY KEY NOT NULL,
	"prior_tier" text,
	"tier_source" text,
	"lifetime_cents" integer DEFAULT 0 NOT NULL,
	"patreon_user_id" text,
	"patreon_name" text,
	"discord_username" text,
	"evidence" text,
	"guild_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "legacy_customers_patreon_idx" ON "legacy_customers" USING btree ("patreon_user_id");