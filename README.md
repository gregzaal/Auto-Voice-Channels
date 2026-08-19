# Auto-Voice-Channels

> **Looking for the Python bot?** It is still here, on the
> [`master`](https://github.com/GregZaal/Auto-Voice-Channels/tree/master) branch:
> MIT licensed, still clonable, still runnable. It is no longer maintained. This
> branch is the TypeScript rewrite that replaces it.

A single Discord bot that automatically creates and cleans up voice channels on
demand. One codebase serves both the **scaled hosted service** (many shards
across multiple instances) and a **private self-hosted instance** (one container
+ Postgres) — differentiated only by configuration.

This is the **TypeScript rewrite** of the Python bot, rebuilt for scale.

**License:** AGPL-3.0-only.

## Architecture (at a glance)

- **discord.js** on Node 22 LTS; Postgres is the source of truth (caches tuned/off).
- **Postgres** via **Drizzle**; coordination uses native primitives (advisory
  locks, `LISTEN/NOTIFY`, lease rows). No Redis.
- **Shards claimed via Postgres leases** (heartbeated). One instance claims all shards.
- **Per-guild in-memory work queues** for ordering, fault isolation, and a
  per-guild circuit-breaker.
- All state-changing operations are **idempotent**; reconciliation is convergent.

Monorepo: [`core/`](./core) (domain logic, DB schema, types, validation) +
[`bot/`](./bot) (gateway/runtime, shard leases, dispatcher, ops). This repo is
the self-hostable bot and is fully runnable on its own.

## Self-hosting

Requirements: Docker + Docker Compose, and a Discord application/bot.

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications)
   and enable the **privileged intents** (Presence, Server Members) — one-time.
   The game-name feature requires the Presence intent.
2. Configure:

   ```bash
   cp .env.example .env     # set DISCORD_TOKEN and CLIENT_ID
   ```

   That's all you need. Self-hosting runs with entitlement gating off by
   default (no trial, billing, or paywall), so there's nothing else to set.

3. Run:

   ```bash
   docker compose up
   ```

   Postgres starts, migrations run automatically on boot, and slash commands
   self-register. Health and diagnostics are served on `http://localhost:8477`
   (the container listens on 8080; compose publishes it on 8477 so it does not
   collide with whatever else you already run on 8080).

### Data persistence and backups

Your data lives in the `pgdata` Docker volume, which survives `docker compose
down` and does not survive `docker compose down -v`. That volume is the whole
of your bot's state: guild settings, name templates, aliases, and every channel
it is tracking.

Backups off-machine are optional and off by default. Set the five
`BACKUP_S3_*` variables in `.env` and the bot dumps Postgres on a schedule,
encrypts it, uploads it, prunes old copies on a grandfather-father-son
retention, and re-checks the newest one every week. No extra container, no
cron, no second thing to keep running. It works against Backblaze B2,
Cloudflare R2, AWS S3, MinIO, or anything else S3-compatible.

Set `BACKUP_ENCRYPTION_KEY` too. The dump contains everything, and with it set
the storage provider only ever sees ciphertext. Generate one with `openssl rand
-base64 32`, and keep a copy somewhere other than the machine it protects:
without the key the backups cannot be recovered by anyone, including you.

Setting only some of the group is a startup error rather than a silent
disable, because a typo that quietly turned backups off would surface during a
restore, which is the worst possible moment to learn about it.

```bash
docker compose exec bot node core/dist/backup/cli.js list     # what exists
docker compose exec bot node core/dist/backup/cli.js drill    # is the newest one restorable
```

Restoring is different, because `pg_restore --clean` drops and recreates tables
the running bot is holding connections and locks on. Stop it first:

```bash
docker compose stop bot
docker compose run --rm bot node core/dist/backup/cli.js restore --force
docker compose start bot
```

(The image ships compiled JavaScript and production dependencies only, so it is
`node core/dist/backup/cli.js` in a container and `pnpm --filter @avc/core run
backup:list` from a source checkout.)

`backup:restore` refuses to write over a database that already has tables
unless you pass `--force`, and `--at <ISO timestamp>` restores the newest
backup at or before a moment rather than the latest.

## Development

Requirements: Node 22 LTS, pnpm (via corepack), Docker (for integration tests).

```bash
corepack enable
pnpm install

pnpm run typecheck          # tsc --build
pnpm run lint               # eslint + prettier --check
pnpm run test               # vitest: unit + integration
pnpm run test:unit          # business-logic unit tests (no Docker)
pnpm run test:integration   # DB / LISTEN-NOTIFY / advisory-lock tests (needs Docker)
pnpm run build
```

- **Unit tests** cover pure business logic.
- **Integration tests** run against a real ephemeral Postgres via Testcontainers,
  so advisory locks / `LISTEN-NOTIFY` / transactions are exercised for real.

### Database migrations

Drizzle + drizzle-kit, following strict **expand/contract** discipline (add
columns/tables first; drop only in a later release). Migrations run automatically
on boot.

```bash
pnpm --filter @avc/core run db:generate   # generate a migration from schema changes
pnpm --filter @avc/core run db:migrate    # apply migrations (uses DATABASE_URL)
```

## Deployment (hosted)

Fly-specific config lives under [`deploy/fly/`](./deploy/fly). Same image as
self-host; only config differs. See [`deploy/fly/README.md`](./deploy/fly/README.md).

## Operability

Debug by querying state, not dashboards:

- `GET /health` — per-subsystem readiness (db, leases, gateway); gates deploys.
- `GET /diagnostics` — live state: claimed shards, per-guild queue depths,
  tripped circuit-breakers, version/commit.
- **SQL views** (`v_shard_ownership`, `v_guild_status`, `v_guild_auth_latest`,
  `v_recent_ops`) for global state straight from Postgres.
- **`runtime_flags`** — DB-backed no-deploy levers; every change is recorded in
  `ops_audit`.
