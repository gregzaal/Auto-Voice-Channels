ALTER TABLE "subscriptions" ADD COLUMN "scheduled_change_action" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "scheduled_change_at" timestamp with time zone;