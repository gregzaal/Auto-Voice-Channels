# Fly deployment (hosted service)

Fly-specific configuration, isolated here so the application never hard-depends
on Fly. The self-hosted profile uses `docker-compose.yml` at the repo root with
the **same image**.

## Prerequisites

Run the examples from the repository root. Replace every `<app>` with the
intended app name and use its matching config for deployment. Backups and
recovery commands target the designated backup-owner app.

- A Fly app and a Fly Postgres (or external Postgres) attached.
- Secrets set (never committed):

  ```bash
  fly secrets set -a <app> DISCORD_TOKEN=... CLIENT_ID=... DATABASE_URL=... DIAGNOSTICS_TOKEN=...
  ```

  Hosted mode requires a diagnostics token of at least 16 characters. Use a
  distinct token per fleet and keep it in the secret store.

- Optional, to enable `/templateassistant`:

  ```bash
  fly secrets set -a <app> AVC_AI_API_KEY=...
  ```

  Without it the command is never registered, so nothing else has to change.
  The endpoint and model are plain `[env]` values in `fly.toml`, not secrets.
  Setting the key makes the command appear on the **next boot's** command
  registration, which is a global upsert and can take up to an hour to
  propagate to clients.

## Deploy

```bash
fly deploy --config deploy/fly/fly.toml --ha=false --build-arg GIT_COMMIT="$(git rev-parse HEAD)"
```

There are three configs here, one per hosted fleet: `fly.toml` (beta),
`fly.prod.toml` (production) and `fly.gold.toml` (gold). Select the intended
config explicitly and inspect its values; they need not match. Each header
documents shared-job ownership and secret requirements. A self-hoster needs
none of them: `docker-compose.yml` at the repo root runs the same image.

**Deploy a single-machine fleet with `--ha=false`.** Fly creates a second machine
on the first deploy of a process group, and against `EXPECTED_INSTANCES=1` the
extra one claims no shards, serves nothing, and logs an error-level "cannot
prove shard ownership" line every ten seconds while it does it.

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

The configured `kill_timeout` gives the graceful drain time to release leases
after stopping background jobs and finishing per-guild queues. A forced kill
leaves the replacement waiting for leases to expire. Keep the drain bounded:
retryable background work must not stall deployment indefinitely. Account for
this budget when adding work to [shutdown](../../bot/src/runtime/shutdown.ts).

Failover is orchestrator-driven: a crashed or lease-lost machine restarts (the
`[restart]` policy in `fly.toml`) and re-claims its shards on boot; survivors do
not poach a dead peer's shards. Boot-time claiming retries across the lease-expiry
window so the replacement reliably picks up the orphaned shards.

## Scaling (shard distribution)

Set `TOTAL_SHARDS` (total across the fleet) and `EXPECTED_INSTANCES` (machine
count) in the selected config's `[env]`. Each instance claims free shards up to
`ceil(TOTAL_SHARDS / EXPECTED_INSTANCES)`, so the shards spread across the fleet.
Keep `EXPECTED_INSTANCES` in sync with the machine count. Setting it too high
can leave shards unclaimed because the actual machines' combined claim caps
are too small. Setting it too low allows early machines to claim a larger
share, leaving other machines under-filled or idle. One instance
(`EXPECTED_INSTANCES=1`) can claim every shard; multiple shards per machine
are supported. Claim caps do not promise identical occupancy when the shard
count is not divisible by the machine count.

Changing `TOTAL_SHARDS` changes the guild-to-shard mapping. Stop the whole
fleet, confirm its gateway sessions have disconnected, update every instance
to the same new total, and only then restart. Do not roll between different
totals. A machine-count change with the same total still needs enough capacity
and coordinated replacement: running peers do not rebalance their leases
automatically. Verify complete shard coverage and proven ownership afterward.

## Backups

Backups run in the bot process. A Postgres advisory lock elects one instance
**per fleet** to take a scheduled backup. If several fleets share a database,
select one backup/drill owner. Other fleets should omit backup credentials;
if credentials are retained, set both `backup.disabled` and
`backup.drill_disabled` to `true`. The two schedules are independent, and
per-fleet election does not prevent duplicate backups or competing drills
across fleets. Use a direct Postgres endpoint for the session-scoped lock and
LISTEN/NOTIFY; a transaction pooler does not preserve those sessions.

```bash
fly secrets set -a <backup-owner-app> \
  BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com \
  BACKUP_S3_REGION=us-west-002 BACKUP_S3_BUCKET=... \
  BACKUP_S3_ACCESS_KEY_ID=... BACKUP_S3_SECRET_ACCESS_KEY=... \
  BACKUP_ENCRYPTION_KEY=...
```

The group is all-or-nothing: set some of it and the process refuses to boot
rather than run with backups quietly off. Tuning (`BACKUP_INTERVAL_HOURS`,
`BACKUP_PREFERRED_HOUR_UTC`, the three `BACKUP_RETENTION_*`, `BACKUP_PREFIX`,
`BACKUP_DRILL_INTERVAL_HOURS`) is plain `[env]` in `fly.toml`, not secrets.

**`BACKUP_DRILL_DATABASE_URL` is the exception and must be a secret**, because
it carries a password. It is optional: without it the weekly
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
fly ssh console -a <backup-owner-app> -C "node /app/core/dist/backup/cli.js list"
```

`/diagnostics` reports `lastRunAt`, `nextDueAt`, `lastSizeBytes`, `stale`, and
the weekly drill's `lastDrillAt` / `lastDrillResult` / `lastDrillProblems`.
`stale` is informational and never gates a deploy: a missing backup is a reason
to page someone, not a reason to block a rollout.

Use `RuntimeFlagsRepository.set` with the owning fleet to change scheduler
controls without deploying: `backup.disabled` stops scheduled backups,
`backup.drill_disabled` stops scheduled verification, and `global.pause`
stops both. Manual backup CLI commands bypass these flags; coordinate them
with any scheduled job before running them.

### Restoring

Restore into a **new, empty database** and validate it before a separate
cutover. Preserve the original database. The CLI otherwise defaults to the
running process's `DATABASE_URL`, so always give an explicit recovery target.

1. Connect to a container with the backup configuration:

   ```bash
   fly ssh console -a <backup-owner-app> --select
   cd /app
   node core/dist/backup/cli.js list
   ```

2. Choose an exact backup object key. Securely set `BACKUP_KEY` and
   `RESTORE_DATABASE_URL` in that shell, and independently confirm the latter
   resolves to the new empty database. Then verify and restore that same
   archive. Do not continue if either command fails:

   ```bash
   : "${BACKUP_KEY:?Set the selected backup object key}"
   : "${RESTORE_DATABASE_URL:?Set a verified EMPTY recovery database URL}"
   node core/dist/backup/cli.js verify --at "$BACKUP_KEY" &&
     node core/dist/backup/cli.js restore --at "$BACKUP_KEY" --to "$RESTORE_DATABASE_URL"
   ```

   The empty-target guard refuses existing public tables. Do not bypass an
   unexpected refusal with `--force`. A restore failure can leave partial data;
   investigate and prepare a fresh empty target before retrying.

3. Check the restore's checksum result and warnings. Validate row counts
   against the backup manifest, tables, indexes, constraints and migration
   history. Inspect the guild/configuration state relevant to the recovery.
   Account for writes since the selected snapshot: a restore does not replay
   them. If the intended build is newer, apply its compatible forward
   migrations before allowing consumers to read the restored schema.

`drill` is a separate verification operation. When `BACKUP_DRILL_DATABASE_URL`
is configured, it restores into and wipes that scratch database. Do not run
it against the recovery database you intend to keep.

### Cutting over after validation

Coordinate every writer to the database, including all bot fleets, external
services and administrative jobs. Stop their writes and prevent automatic
restarts before switching connections. `global.pause` is not sufficient:
commands and other write paths remain active. Arrange retryable ingress for
external events, and decide how to handle post-snapshot changes before cutover.

With all old writers stopped, update the connection configuration for every
consumer. Start the compatible bot build to apply any pending migrations,
confirm migration success, then start the remaining consumers. Verify health,
shard coverage, ownership and the recovered behavior on every affected fleet.
Never run old and restored databases as competing writable sources of truth.
Retain the original database until the recovery is confirmed; switching back
after new writes requires a data-reconciliation decision of its own.

## Health & rollback

`/health` reports per-subsystem readiness (db, leases, gateway), with the db status
refreshed by a live ping. The configured Fly health check supplies the rolling
deployment's readiness signal; rollback is an orchestrator/operator action,
not bot-side logic. Check the deployment result and each affected machine.

`INSTANCE_ID` is sourced automatically from Fly's per-machine `FLY_MACHINE_ID`
(config falls back to it when `INSTANCE_ID` is unset), so every machine gets a
unique shard-lease identity. The machine count should match
`EXPECTED_INSTANCES`, which need not equal `TOTAL_SHARDS`. Use `--ha=false`
for a fleet intended to have one machine, and check the actual machine count
after deployment.

Inspect each machine's health and diagnostics rather than relying only on a
load-balanced URL. A single-machine fleet has no serving peer during
replacement. Keep a compatible previous image available, and verify schema
and stored-data compatibility before reverting: an image rollback does not
undo database writes.
