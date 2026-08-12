ALTER TABLE "subscriptions" ADD COLUMN "refund_status" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "refund_total" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "refund_at" timestamp with time zone;