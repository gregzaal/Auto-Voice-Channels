-- Fleet scoping (plans/fleets.md §2).
--
-- HAND-CORRECTED from drizzle-kit's output, which was not runnable:
--   1. It emitted the ADD CONSTRAINT ... PRIMARY KEY statements BEFORE the
--      ADD COLUMN "fleet" statements they depend on.
--   2. It could not resolve the existing primary-key constraint names and left
--      the DROP CONSTRAINT lines commented out, so every ADD PRIMARY KEY would
--      have failed with "multiple primary keys are not allowed".
-- The names below were read from information_schema on a real database; they are
-- Postgres's defaults (<table>_pkey), unchanged since these tables were created.
--
-- Additive by construction: every fleet column defaults to 'prod', so existing
-- rows and every row a self-host will ever write are production rows, and code
-- that predates fleets keeps reading and writing exactly what it did before.

-- Columns first, so the key swaps below have something to key on.
ALTER TABLE "auto_channels" ADD COLUMN "fleet" text DEFAULT 'prod' NOT NULL;--> statement-breakpoint
ALTER TABLE "secondary_channels" ADD COLUMN "fleet" text DEFAULT 'prod' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_channels" ADD COLUMN "fleet" text DEFAULT 'prod' NOT NULL;--> statement-breakpoint
ALTER TABLE "join_channels" ADD COLUMN "fleet" text DEFAULT 'prod' NOT NULL;--> statement-breakpoint
ALTER TABLE "identify_buckets" ADD COLUMN "fleet" text DEFAULT 'prod' NOT NULL;--> statement-breakpoint
ALTER TABLE "runtime_flags" ADD COLUMN "fleet" text DEFAULT 'prod' NOT NULL;--> statement-breakpoint
ALTER TABLE "shard_leases" ADD COLUMN "fleet" text DEFAULT 'prod' NOT NULL;--> statement-breakpoint

-- Nullable, unlike every other fleet column: an action taken from the web
-- console originates outside any fleet, and stamping it 'prod' would be a lie.
ALTER TABLE "ops_audit" ADD COLUMN "fleet" text;--> statement-breakpoint

-- Key swaps. These are what actually let two fleets coexist: until the old
-- single-column key is gone, beta claiming shard 0 collides with prod's shard 0.
ALTER TABLE "identify_buckets" DROP CONSTRAINT "identify_buckets_pkey";--> statement-breakpoint
ALTER TABLE "identify_buckets" ADD CONSTRAINT "identify_buckets_fleet_bucket_pk" PRIMARY KEY("fleet","bucket");--> statement-breakpoint
ALTER TABLE "runtime_flags" DROP CONSTRAINT "runtime_flags_pkey";--> statement-breakpoint
ALTER TABLE "runtime_flags" ADD CONSTRAINT "runtime_flags_fleet_key_pk" PRIMARY KEY("fleet","key");--> statement-breakpoint
ALTER TABLE "shard_leases" DROP CONSTRAINT "shard_leases_pkey";--> statement-breakpoint
ALTER TABLE "shard_leases" ADD CONSTRAINT "shard_leases_fleet_shard_id_pk" PRIMARY KEY("fleet","shard_id");--> statement-breakpoint

-- Per-fleet guild presence: "the bot was removed" has to name which bot now.
CREATE TABLE "guild_fleet_presence" (
	"guild_id" text NOT NULL,
	"fleet" text DEFAULT 'prod' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_fleet_presence_guild_id_fleet_pk" PRIMARY KEY("guild_id","fleet")
);--> statement-breakpoint

-- Backfill presence from the shared column it replaces, so the first boot after
-- this migration does not report every existing guild as newly discovered.
-- `bot_removed_at` is retained for now (expand/contract): it is dropped in a
-- later release, once nothing reads it.
INSERT INTO "guild_fleet_presence" ("guild_id", "fleet", "created_at", "removed_at")
SELECT "guild_id", 'prod', "created_at", "bot_removed_at" FROM "guilds"
ON CONFLICT DO NOTHING;--> statement-breakpoint

CREATE INDEX "guild_fleet_presence_fleet_idx" ON "guild_fleet_presence" USING btree ("fleet","removed_at");--> statement-breakpoint

-- Guild lookups are always fleet-scoped now, so the fleet leads the index.
DROP INDEX "auto_channels_guild_idx";--> statement-breakpoint
DROP INDEX "managed_channels_guild_idx";--> statement-breakpoint
DROP INDEX "secondary_channels_guild_idx";--> statement-breakpoint
CREATE INDEX "auto_channels_guild_idx" ON "auto_channels" USING btree ("fleet","guild_id");--> statement-breakpoint
CREATE INDEX "managed_channels_guild_idx" ON "managed_channels" USING btree ("fleet","guild_id");--> statement-breakpoint
CREATE INDEX "secondary_channels_guild_idx" ON "secondary_channels" USING btree ("fleet","guild_id");
