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

- Optional, to enable `/templateassistant`:

  ```bash
  fly secrets set AVC_AI_API_KEY=...
  ```

  Without it the command is never registered, so nothing else has to change.
  The endpoint and model are plain `[env]` values in `fly.toml`, not secrets.
  Setting the key makes the command appear on the **next boot's** command
  registration, which is a global upsert and can take up to an hour to
  propagate to clients.

## Deploy

```bash
fly deploy --config deploy/fly/fly.toml --build-arg GIT_COMMIT="$(git rev-parse HEAD)"
```

**Pass `GIT_COMMIT`.** It is what `/health` and `/diagnostics` report as `commit`,
and it is how you tie an incident to a build. The Dockerfile defaults it to `dev`
so a self-host `docker compose up` needs no flags — which means a deploy without
the flag silently leaves the running fleet unable to say which build it is.
`fly.toml` cannot supply it (build args there are static, and this one has to be
evaluated at deploy time), so it lives on the command line.

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

`INSTANCE_ID` is sourced automatically from Fly's per-machine `FLY_MACHINE_ID`
(config falls back to it when `INSTANCE_ID` is unset), so every machine gets a
unique shard-lease identity — no entry script needed. **Run a Discord bot as a
single machine per shard** (`fly scale count <n>` = your machine count); Fly's
default of 2 machines for a new app must be scaled to match `TOTAL_SHARDS` /
`EXPECTED_INSTANCES`, or instances contend for the same shard.

## TODO

- Confirm `TOTAL_SHARDS` + `EXPECTED_INSTANCES` per scale and the Postgres attachment.
- Add `fly.toml` `[mounts]`/regions as the topology is finalized.
