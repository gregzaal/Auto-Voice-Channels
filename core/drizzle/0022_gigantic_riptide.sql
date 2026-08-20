ALTER TABLE "alerts" ADD COLUMN "claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "alerts_claimable_idx" ON "alerts" USING btree ("fleet","opened_at") WHERE delivered_at IS NULL AND resolved_at IS NULL;