-- Custom SQL migration file, put your code below! --

-- Read-only diagnostic views over the coordination tables, so an operator (or
-- the AI agent) can inspect global state straight from Postgres. These are
-- additive and backward-compatible (expand/contract safe).

-- Shard ownership + lease health. `healthy` is true when the lease was
-- heartbeated within the last 30s.
CREATE OR REPLACE VIEW v_shard_ownership AS
SELECT
  shard_id,
  total_shards,
  instance_id,
  heartbeat_at,
  claimed_at,
  (instance_id IS NOT NULL AND heartbeat_at > now() - interval '30 seconds') AS healthy
FROM shard_leases
ORDER BY shard_id;

-- Per-guild status: auth state + entitlement window.
CREATE OR REPLACE VIEW v_guild_status AS
SELECT
  guild_id,
  auth_status,
  auth_expires_at,
  (auth_status IN ('trial', 'active')) AS entitled,
  updated_at
FROM guilds;

-- The latest auth event per guild (most recent transition).
CREATE OR REPLACE VIEW v_guild_auth_latest AS
SELECT DISTINCT ON (guild_id)
  guild_id,
  from_status,
  to_status,
  reason,
  actor,
  created_at
FROM guild_auth_events
ORDER BY guild_id, created_at DESC;

-- Recent operational actions (newest first).
CREATE OR REPLACE VIEW v_recent_ops AS
SELECT actor, action, target, details, created_at
FROM ops_audit
ORDER BY created_at DESC
LIMIT 200;