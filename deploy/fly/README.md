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
`bot/src/index.ts`). Moved shards are re-claimed by surviving/new instances and
re-identify staggered; reconcile runs on `READY`.

## Health & rollback

`/health` reports per-subsystem readiness (db, leases, gateway). The Fly health
check gates the rolling deploy and triggers automatic rollback on failure.

## TODO

- Map the Fly machine id to `INSTANCE_ID` via a small entry script.
- Confirm `TOTAL_SHARDS` per scale and the Postgres attachment.
- Add `fly.toml` `[mounts]`/regions as the topology is finalized.
