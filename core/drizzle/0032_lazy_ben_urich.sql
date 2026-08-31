ALTER TABLE "subscriptions" ADD COLUMN "refund_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "refund_settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "refund_adjustment_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "refund_currency" text;