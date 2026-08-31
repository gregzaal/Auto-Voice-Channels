ALTER TABLE "subscriptions" ADD COLUMN "first_charged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "refund_requested_at" timestamp with time zone;