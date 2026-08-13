-- Custom SQL migration file, put your code below! --

-- Fleet-aware diagnostic views (plans/fleets.md).
--
-- These are the views an operator reaches for first, and 0017 quietly made two
-- of them misleading rather than merely incomplete: with a second fleet running,
-- v_shard_ownership would interleave two fleets' shard 0..N rows ordered by
-- shard_id alone, so "who owns shard 3" would have two answers and no way to
-- tell them apart. Same for v_recent_ops, where a beta flag change and a
-- production one would be indistinguishable.
--
-- DROP + CREATE rather than CREATE OR REPLACE: replacing a view can only append
-- columns to the end of the list, and fleet belongs at the front of the sort.
-- Safe because these are read-only diagnostics with no dependent objects.

DROP VIEW IF EXISTS v_shard_ownership;--> statement-breakpoint
CREATE VIEW v_shard_ownership AS
SELECT
  fleet,
  shard_id,
  total_shards,
  instance_id,
  heartbeat_at,
  claimed_at,
  (instance_id IS NOT NULL AND heartbeat_at > now() - interval '30 seconds') AS healthy
FROM shard_leases
ORDER BY fleet, shard_id;--> statement-breakpoint

DROP VIEW IF EXISTS v_recent_ops;--> statement-breakpoint
CREATE VIEW v_recent_ops AS
SELECT actor, action, target, fleet, details, created_at
FROM ops_audit
ORDER BY created_at DESC
LIMIT 200;--> statement-breakpoint

-- Which fleets are in a guild, alongside the entitlement they share. Answers
-- the question the old bot_removed_at column cannot: a guild running beta with
-- production absent is healthy, not missing a bot.
CREATE OR REPLACE VIEW v_guild_fleets AS
SELECT
  g.guild_id,
  g.name,
  g.auth_status,
  p.fleet,
  p.created_at AS first_seen_at,
  p.removed_at,
  (p.removed_at IS NULL) AS present
FROM guilds g
LEFT JOIN guild_fleet_presence p ON p.guild_id = g.guild_id
ORDER BY g.guild_id, p.fleet;
