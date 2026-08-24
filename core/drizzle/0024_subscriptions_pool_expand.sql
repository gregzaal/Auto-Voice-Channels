ALTER TABLE "subscriptions" ADD COLUMN "id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "pool_id" text;--> statement-breakpoint
UPDATE "subscriptions" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_id_unique" UNIQUE("id");