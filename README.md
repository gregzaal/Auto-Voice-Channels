# Auto-Voice-Channels

A single Discord bot that automatically creates and cleans up voice channels on
demand. One codebase serves both the **scaled hosted service** (many shards
across multiple instances) and a **private self-hosted instance** (one container
+ Postgres) — differentiated only by configuration.

This is the **TypeScript rewrite**. See [`rewrite.md`](./rewrite.md) for the full
design and decision log.

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
   self-register. Health/diagnostics are served on `http://localhost:8080`.

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

See [`AGENTS.md`](./AGENTS.md) for the full runbook and diagnostics cookbook.
