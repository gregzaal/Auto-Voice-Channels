ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_id_unique";--> statement-breakpoint
-- The old inline `guildId: text('guild_id').primaryKey()` created Postgres's
-- default-named constraint. Confirmed against the live schema (both the local
-- dev database and the 0000_init.sql that first created this table use the
-- same unqualified `.primaryKey()` shorthand, which Postgres always names
-- "<table>_pkey"), rather than guessed: drizzle-kit cannot introspect the name
-- of a constraint it did not itself create with an explicit name.
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_pkey";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "guild_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_guild_id_unique" UNIQUE("guild_id");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_pool_id_unique" UNIQUE("pool_id");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_guild_xor_pool" CHECK (num_nonnulls("subscriptions"."guild_id", "subscriptions"."pool_id") = 1);