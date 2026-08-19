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

## Backups

Backups run **in the fleet**, not on a separate machine: the scheduler is
in-process and elects a leader with a Postgres advisory lock, so exactly one
instance takes each backup no matter how many are running. Nothing extra to
deploy, and nothing extra to notice when it stops.

```bash
fly secrets set   BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com   BACKUP_S3_REGION=us-west-002   BACKUP_S3_BUCKET=...   BACKUP_S3_ACCESS_KEY_ID=...   BACKUP_S3_SECRET_ACCESS_KEY=...   BACKUP_ENCRYPTION_KEY=...
```

The group is all-or-nothing: set some of it and the process refuses to boot
rather than run with backups quietly off. Tuning (`BACKUP_INTERVAL_HOURS`,
`BACKUP_PREFERRED_HOUR_UTC`, the three `BACKUP_RETENTION_*`, `BACKUP_PREFIX`,
`BACKUP_DRILL_INTERVAL_HOURS`) is plain `[env]` in `fly.toml`, not secrets.

**`BACKUP_DRILL_DATABASE_URL` is the exception and must be a secret**, because
it carries a password. It is optional and unset here: without it the weekly
drill still downloads, checksums, decrypts and parses the newest backup, which
is what catches storage going bad. With it, the drill also restores into that
database and compares row counts, then wipes it. It must point at a **separate
and initially empty** database. The drill refuses anything that already holds
tables it did not put there, so a mistake fails loudly rather than restoring
over something.

**`BACKUP_ENCRYPTION_KEY` is the one that cannot be regenerated.** Losing it
loses every backup it protects, and the loss is invisible until a restore.
Escrow it outside Fly.

Check on it without deploying anything:

```bash
curl -H "Authorization: Bearer $DIAGNOSTICS_TOKEN" https://<app>.fly.dev/diagnostics | jq .backup
fly ssh console -C "node /app/core/dist/backup/cli.js list"
```

`/diagnostics` reports `lastRunAt`, `nextDueAt`, `lastSizeBytes`, `stale`, and
the weekly drill's `lastDrillAt` / `lastDrillResult` / `lastDrillProblems`.
`stale` is informational and never gates a deploy: a missing backup is a reason
to page someone, not a reason to block a rollout.

Two runtime flags turn things off without a deploy, through `/admin/ops` or
`RuntimeFlagsRepository.set`: `backup.disabled` stops backups, and
`backup.drill_disabled` stops only the weekly verification. `global.pause`
stops both.

### Restoring

```bash
fly ssh console
cd /app
node core/dist/backup/cli.js list
node core/dist/backup/cli.js drill      # is the newest one restorable
node core/dist/backup/cli.js restore --force
```

Restore into a **new** database first and point `DATABASE_URL` at it once the
row counts look right. Restoring over the live database is possible with
`--force` and is almost never the fastest way back: a fresh database can be
checked before anything starts reading it.

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
