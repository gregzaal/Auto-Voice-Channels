ALTER TABLE "guild_auth_events" ADD COLUMN "from_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guild_auth_events" ADD COLUMN "to_expires_at" timestamp with time zone;