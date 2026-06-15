# Fly deployment (hosted service)

Fly-specific configuration, isolated here so the application never hard-depends
on Fly. The self-hosted profile uses `docker-compose.yml` at the repo root with
the **same image**.

## Prerequisites

- A Fly app and a Fly Postgres (or external Postgres) attached.
- Secrets set (never committed):

  ```bash
  fly secrets set DISCORD_TOKEN=... CLIENT_ID=... DATABASE_URL=...
  ```

## Deploy

```bash
fly deploy --config deploy/fly/fly.toml
```

Rolling deploy + graceful drain: on `SIGTERM` the bot stops new work, finishes
in-flight per-guild queues, releases its shard leases, and exits (see
`bot/src/index.ts`). Cross-instance identifies are serialized by a Postgres-backed
throttler (respecting Discord `max_concurrency`), so simultaneous re-identifies on
a deploy are safe — there is no manual staggering. Reconcile runs on `READY`.

Failover is orchestrator-driven: a crashed or lease-lost machine restarts (the
`[restart]` policy in `fly.toml`) and re-claims its shards on boot; survivors do
not poach a dead peer's shards. Boot-time claiming retries across the lease-expiry
window so the replacement reliably picks up the orphaned shards.

## Scaling (shard distribution)

Set `TOTAL_SHARDS` (total across the fleet) and `EXPECTED_INSTANCES` (machine
count) in `fly.toml`'s `[env]`. Each instance claims free shards up to
`ceil(TOTAL_SHARDS / EXPECTED_INSTANCES)`, so the shards spread across the fleet.
Keep `EXPECTED_INSTANCES` in sync with the machine count: too low and some shards
go unclaimed; too high and instances under-fill. One instance (`EXPECTED_INSTANCES=1`)
claims every shard.

## Health & rollback

`/health` reports per-subsystem readiness (db, leases, gateway), with the db status
refreshed by a live ping. The Fly health check gates the rolling deploy; a failing
check halts/rolls back the rollout (Fly's deploy behavior, not bot-side logic).

## TODO

- Map the Fly machine id to `INSTANCE_ID` via a small entry script.
- Confirm `TOTAL_SHARDS` + `EXPECTED_INSTANCES` per scale and the Postgres attachment.
- Add `fly.toml` `[mounts]`/regions as the topology is finalized.
