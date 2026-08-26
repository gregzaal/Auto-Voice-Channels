ALTER TABLE "billing_events" ADD COLUMN "pool_id" text;--> statement-breakpoint
CREATE INDEX "billing_events_pool_idx" ON "billing_events" USING btree ("pool_id","created_at");