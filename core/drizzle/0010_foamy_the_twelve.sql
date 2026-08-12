ALTER TABLE "guilds" ADD COLUMN "bot_removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "purchaser_user_id" text;