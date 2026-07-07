ALTER TABLE "secondary_channels" ADD COLUMN "original_creator" text;--> statement-breakpoint
-- Backfill: existing channels' current owner is treated as their original creator.
UPDATE "secondary_channels" SET "original_creator" = "owner_id" WHERE "original_creator" IS NULL AND "owner_id" IS NOT NULL;