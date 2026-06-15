# AGENTS.md

Operating guide for the **TypeScript rewrite** of Auto-Voice-Channels. The full design and the
rationale behind every decision live in [`rewrite.md`](./rewrite.md) — read it first; this file is
the practical runbook for developing, deploying, debugging, and maintaining the system.

> **Status:** the rewrite is implemented end-to-end (roadmap phases 1–9): foundation, persistence +
> auth-state, shard leases, gateway + per-guild dispatcher, core voice features, reconciliation
> (reconcile-on-READY + scoped sweep + dry-run), the slash-command/`/settings` surface, the runtime
> control plane, and self-host/Fly deployment. Remaining items are marked **TODO** below. Keep this
> file accurate — it is the primary context for both AI agents and humans operating the service.

This system is **primarily operated by an AI agent** (development, deployment, live debugging,
maintenance). Optimize for machine-consumable signals and safe, reversible automation. A human must
always remain *able* to operate and observe it.

---

## What this is

A single Discord bot that automatically creates/cleans up voice channels on demand. One codebase
serves both the **scaled hosted service** (many shards across multiple Fly instances) and a
**private self-hosted instance** (one container + Postgres) — differentiated only by configuration.
Licensed **AGPL-3.0**.

Key architecture facts (see `rewrite.md` for detail):

- **discord.js** on Node LTS; Postgres is the source of truth, caches are tuned/disabled.
- **Postgres** (single primary, replica-ready) via **Drizzle**; coordination uses native Postgres
  primitives (advisory locks, `LISTEN/NOTIFY`, `FOR UPDATE SKIP LOCKED`). No Redis.
- **Shards are claimed via Postgres leases** (heartbeated). At one instance, it claims all shards.
- **Per-guild in-memory work queues** give ordering + fault isolation + a per-guild circuit-breaker.
- **Event-driven** with reconcile-on-reconnect and a thin scoped safety-net sweep. All state-changing
  operations are **idempotent**; reconciliation is **convergent**.

---

## Golden rules (invariants — do not violate)

1. **Idempotency.** Every state-changing operation must be safe to retry/replay. Reconciliation must
   converge, never duplicate or thrash channels.
2. **Per-guild isolation.** One guild's error, bad data, or abuse must never crash a shard or affect
   other guilds. Catch and contain at the per-guild boundary; trip the circuit-breaker, don't escalate.
3. **Expand/contract migrations only.** Rolling deploys run old + new versions simultaneously. Never
   ship a migration that breaks the currently-running version. Add columns/tables first; remove only
   after all instances no longer reference them (a later release).
4. **Don't break the running version.** Deploys must be backward-compatible and health/readiness-gated
   with auto-rollback.
5. **One codebase, config-driven.** No forked "lite" build, no second SQL dialect. Self-host vs hosted
   differ only by config. Keep the app deployment-agnostic; Fly specifics live under `deploy/fly/`.
6. **Tests gate everything.** Typecheck + lint + unit + integration must pass before any deploy.
7. **Never commit secrets.** Tokens/credentials come from env (Fly secrets / `.env`), never the repo.
8. **AGPL-3.0 compliance.** Preserve license and notices; keep source obligations intact.

---

## Repository layout (rewrite)

```
core/            # domain logic, DB schema (Drizzle), types, validation (zod) — reused by future dashboard
bot/             # gateway/runtime, shard lease manager, dispatcher, feature handlers, commands, ops
deploy/fly/      # Fly-specific deployment config (isolated; app must not depend on Fly)
docker-compose.yml  # self-host: bot + Postgres
rewrite.md       # design + decision log (source of truth)
AGENTS.md        # this file
```

Workspaces (pnpm): `@avc/core` (in `core/`) and `@avc/bot` (in `bot/`). A future
dashboard would be a third package depending on `@avc/core`.

---

## Development workflow (TDD)

Write a failing test → implement → green. Reference the legacy Python code for feature behaviour.

Package manager: **pnpm** (pinned via corepack, see `packageManager` in `package.json`). Commands
run from the repo root:

```bash
corepack enable              # one-time: activate the pinned pnpm
pnpm install                 # install deps (frozen lockfile in CI)
pnpm run typecheck           # tsc --build (project references)
pnpm run lint                # eslint + prettier --check
pnpm run test                # Vitest: unit + integration
pnpm run test:unit           # business-logic unit tests (no Docker)
pnpm run test:integration    # DB + LISTEN/NOTIFY + advisory-lock tests (needs Docker for Testcontainers)
pnpm run build               # build core + bot
```

Test file naming: `*.unit.test.ts` (unit project) and `*.integration.test.ts` (integration project).

- **Unit tests** cover business logic (pure, fast).
- **DB integration tests** run against a **real ephemeral Postgres** (Testcontainers) so advisory
  locks / `LISTEN-NOTIFY` / `SKIP LOCKED` / transactions are exercised for real. Requires Docker.
- **Discord-event integration tests** feed raw gateway dispatches through the real dispatcher pipeline
  and assert against a **fake REST/action recorder** (which channels were created/deleted/moved).
- **CI gates:** typecheck + lint + all tests must pass before merge/deploy.

For development, we have a dev version of the bot with ID `601753426140856329`. The live production bot will be `479393422705426432`.

## Command surface

Hybrid slash commands (rewrite.md decision 11), defined in `bot/src/commands/definitions.ts` and
self-registered globally on boot (idempotent upsert). Routing lives in `bot/src/commands/interactions.ts`;
the underlying logic is the tested `VoiceCommands` / `GuildSettingsService` / `VoteKickManager` in
`bot/src/features/voice/`. Every interaction runs through the per-guild dispatcher (ordered against voice
events, fault-isolated) and is refused for `blocked` guilds.

- **Per-channel (owner-gated in logic, open to all):** `/limit`, `/unlimit`, `/name` (override or `reset`),
  `/private`, `/public`, `/transfer`, `/claim` (take over when the owner left), `/kick` (majority votekick).
- **Utility (open to all):** `/nick` (custom `@@creator@@` name), `/ping`, `/invite`.
- **Admin (`ManageChannels`):** `/create` (new creator/primary channel, entitlement-gated), `/settings`
  (ephemeral panel: automation, default template, "no game" label, aliases, creator channels — buttons +
  modals, custom-id prefix `avc:settings:`), `/rename` (rename any managed channel by id),
  `/position` (modal: new channels above/below the creator — default below), `/inheritpermissions` (copy perms from
  primary/category/channel), `/logging` (per-guild event log channel + level 1–3).

**Private channels:** `/private` locks the channel to @everyone and spawns a "⇩ Join {creator}" companion
channel. Joining the companion posts an Approve/Deny/Block request (custom-id prefix `avc:join:`) into the
**private channel's own integrated text chat** — only the owner (inside the channel) and admitted members
can see it; outsiders and the un-admitted requester cannot. Requester-facing feedback ("request sent",
"declined"/"blocked") goes to the **public companion's** text chat instead, since the requester can't see
the private channel. The companion is tracked in `join_channels` (keyed by its own id, with the fronted
secondary id) and deleted on `/public` or when the channel is cleaned up.

> **Text-in-voice gating (non-obvious):** Discord gates a voice channel's built-in text chat on the
> *effective `Connect`* permission, **not** `View Channel`. So denying `Connect` to @everyone (what
> `/private` does) already hides the text chat **and its history** from non-members — and a member later
> granted `Connect` sees only go-forward messages, never history from before they were admitted. The whole
> privacy/kick model is therefore built on `Connect` alone; do **not** add `View Channel`/`Read Message
> History` overwrites for privacy (they're unnecessary, and the bot isn't even invited with RMH).

**Name templates** (`renderChannelName`, all available to every guild): index tokens (`##`, `$0#`, `+#`),
`@@nato@@`, `@@game_name@@`, `@@num@@`/`@@num_others@@`, `@@creator@@`, `@@stream_name@@`, the
rich-presence party tokens (`@@num_playing@@`, `@@party_size@@`, `@@party_state@@`, `@@party_details@@`),
`[[a/b/c]]` (random, **fixed once per channel** via a stored `seed` so it never causes a rename),
`<<one/many>>` singular/plural, and `{{cond ?? yes // no}}` conditionals (`LIVE`, `ROLE:id`, `GAME`,
`PLAYERS`, `MAX`, `RICH`). The default template is a random emoji + `@@creator@@`'s + random word.

---

## Database & migrations

- ORM: **Drizzle**; migrations via **drizzle-kit**. Migrations run automatically on boot.
- Follow **expand/contract** strictly (see Golden Rules). Two-phase any rename/drop across releases.
- Coordination tables include `shard_leases`, `runtime_flags`, `ops_audit`, plus the domain tables
  (`guilds`, `guild_auth_events`, `auto_channels`, `secondary_channels`, `join_channels`, `aliases`, …).
  See `rewrite.md`.

Add a migration (review for backward-compat / index impact / lock duration before committing):

```bash
pnpm --filter @avc/core run db:generate          # generate from schema.ts changes
pnpm --filter @avc/core exec drizzle-kit generate --custom --name <desc>   # custom SQL (e.g. views)
pnpm --filter @avc/core run db:migrate           # apply (uses DATABASE_URL)
```

Generated SQL lives in `core/drizzle/`. Migrations run automatically on boot (`runMigrations`).

---

## Running locally / self-hosting

Self-host is the standard, simple path — same binary as production:

```bash
cp .env.example .env          # set DISCORD_TOKEN, CLIENT_ID, etc.
docker compose up             # starts bot + Postgres; migrations auto-run; slash commands self-register
```

- Set **`SELF_HOSTED=true`** to disable entitlement gating (no trial/active/expired/billing). The
  monetization concepts stay dormant.
- Enable the **privileged intents** (Presence, Server Members) in the Discord Developer Portal — one
  time. The game-name feature requires the Presence intent.
- Config is **zod-validated at startup**; the process fails fast on bad/missing config.

See `.env.example` for the full, authoritative variable list (`DISCORD_TOKEN`, `CLIENT_ID`,
`DATABASE_URL`, `SELF_HOSTED`, `TOTAL_SHARDS`, `INSTANCE_ID`, `HTTP_PORT`, `ADMIN_CHANNEL_ID`,
`LOG_LEVEL`, `NODE_ENV`).

---

## Deployment (hosted service)

- **Fly rolling deploy** + **graceful drain** (stop new work → finish in-flight per-guild queues →
  release shard leases) + lease handoff to new instances. Moved shards re-identify **staggered**
  (respecting Discord `max_concurrency`); reconcile on `READY`.
- **Readiness-gated with automatic rollback.** Health reports **per subsystem** (gateway connected?
  shard leases held? DB reachable?) so failures are localizable.
- Channel automation is not latency-critical: brief, staggered, per-shard reconnect blips are expected
  and acceptable during a deploy.

Fly config lives under `deploy/fly/` (`fly.toml` + `README.md`). Deploy with
`fly deploy --config deploy/fly/fly.toml`; the `/health` check gates the rolling deploy and triggers
auto-rollback. Graceful drain is handled on `SIGTERM` in `bot/src/index.ts`.

---

## Operations & live debugging

Debug by **querying state**, not by reading dashboards.

### Introspection

- **Diagnostics endpoint** (HTTP, read-only) per instance at `GET /diagnostics`: claimed shards,
  per-guild queue depths, tripped circuit-breakers, queue snapshot, version/commit. Readiness is at
  `GET /health` (per subsystem: db, leases, gateway). Served on `HTTP_PORT` (default 8080).
- **SQL views** over coordination tables for global state straight from Postgres: `v_shard_ownership`
  (shard ownership + lease health), `v_guild_status` (auth state + entitlement), `v_guild_auth_latest`
  (latest transition per guild), `v_recent_ops` (recent `ops_audit`). Defined in
  `core/drizzle/0001_diagnostics_views.sql`.
- **Correlation/trace IDs** thread each event → handler → Discord-action through the structured
  (pino/JSON) logs. To trace one operation, filter logs by its correlation id.

### Runtime control plane (no-deploy levers)

`runtime_flags` (DB-backed) can be toggled live without shipping code. Every change should be made
via `RuntimeFlagsRepository.set(...)`, which records an `ops_audit` entry (actor, what, when, why)
in the same transaction so humans can see and reverse agent actions. Flag keys are defined once in
`core/src/domain/runtimeFlags.ts` (`RUNTIME_FLAGS`); the bot reads them through the creation gate
(`bot/src/runtime/creationGate.ts`) and the reconciler.

Implemented levers:

| Flag key | Type | Effect |
| --- | --- | --- |
| `global.pause` | `boolean` | Master kill-switch — suppresses all live channel creation **and** reconcile/sweep. |
| `sweep.disabled` | `boolean` | Disables only the periodic safety-net sweep (reconcile-on-READY still runs). |
| `create.rate_limit_per_min` | `number` | Per-guild sliding-window cap on secondary creations per minute (`0`/unset = unlimited). |

Set a flag (records to `ops_audit` automatically):

```sql
-- e.g. pause everything (prefer RuntimeFlagsRepository.set so ops_audit is written):
INSERT INTO runtime_flags (key, value, updated_by) VALUES ('global.pause', 'true', 'agent')
ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
INSERT INTO ops_audit (actor, action, target, details) VALUES ('agent', 'flag.set', 'global.pause', '{"value": true}');
```

Other levers (not flag-based):

- **Force-reconcile / dry-run** a guild — call `Reconciler.reconcileGuild(guildId, { dryRun })` (dry-run
  returns the drift it *would* fix without acting). The sweep does this automatically for active guilds.
- **Block/unblock a guild** — set the guild's `auth_status` to `blocked` via
  `GuildRepository.transitionAuth(...)` (writes a `guild_auth_events` row). `blocked` is the per-guild
  kill-switch: no creation, and all slash commands are refused for that guild.

The live control-plane state is also visible read-only at `GET /diagnostics` (`paused`, `sweepEnabled`,
`runtimeFlags`).

### Diagnostics cookbook

Common queries for frequent investigations (SQL views are defined in
`core/drizzle/0001_diagnostics_views.sql`):

```sql
-- Which instance owns guild X's shard, and is its lease healthy?
-- (shard = (guild_id >> 22) % total_shards; compute total_shards from shard_leases)
SELECT * FROM v_shard_ownership ORDER BY shard_id;

-- A guild's auth/entitlement state and latest transition.
SELECT * FROM v_guild_status WHERE guild_id = 'X';
SELECT * FROM v_guild_auth_latest WHERE guild_id = 'X';

-- Recent operational actions (flag changes, blocks) in the last hour.
SELECT * FROM v_recent_ops WHERE created_at > now() - interval '1 hour';

-- Current control-plane flags.
SELECT key, value, updated_by, updated_at FROM runtime_flags ORDER BY key;

-- All managed channels for a guild (primaries + secondaries).
SELECT 'primary' AS kind, channel_id FROM auto_channels WHERE guild_id = 'X'
UNION ALL
SELECT 'secondary', channel_id FROM secondary_channels WHERE guild_id = 'X';
```

Per-instance live state (queue depths, tripped breakers, claimed shards, pause/flag snapshot) is at
`GET /diagnostics`. To dry-run reconcile a guild without acting, call
`Reconciler.reconcileGuild(guildId, { dryRun: true })` and inspect the returned `GuildDrift`.

### Common failure modes → recovery

TODO: expand from real incidents. Starting set:

| Symptom | Likely cause | First response |
| --- | --- | --- |
| Shards offline after deploy | lease not re-claimed / identify backlog | check `shard_leases` heartbeats; verify staggered identify; let reconcile run |
| Duplicate/orphaned channels in one guild | missed event / non-idempotent path | dry-run reconcile that guild, then force-reconcile |
| One guild misbehaving, others fine | tripped circuit-breaker / bad data | inspect guild via diagnostics; `block` if abusive; fix data |
| Channel renames not applying | rename rate limit / presence handling | expected debounce; confirm Discord rate-limit headers |
| DB connection errors | primary unreachable / pool exhausted | check health subsystem; Postgres status; pool config |

---

## Conventions

- **TypeScript** throughout; strict mode. Lint/format: **ESLint** (`eslint.config.js`) + **Prettier**
  (`.prettierrc.json`); `pnpm run lint` checks both, `pnpm run format` fixes.
- **Logging:** pino structured JSON; always include guild id (where applicable) and correlation id.
- **Errors:** catch at the per-guild boundary; log with context; report significant errors to the
  admin Discord channel (seam for a Sentry-style sink later). Never let one guild's error escalate.
- **Config:** all via env, **zod-validated at startup**, fail fast.
- **Validation:** validate external/DB data at the boundary (zod); a corrupt row quarantines to its guild.

---

## Safety checklist before deploying (agent + human)

- [ ] Typecheck, lint, and all tests pass locally and in CI.
- [ ] Any schema change is **expand/contract** and backward-compatible with the running version.
- [ ] No secrets added to the repo.
- [ ] Health/readiness checks updated if a new subsystem was added.
- [ ] Reversible: know the rollback path and the relevant `runtime_flags` mitigations.

---

## Glossary

- **Primary / auto channel** — a creator channel; joining it spawns a secondary.
- **Secondary channel** — a bot-managed temporary voice channel (tracked for reconciliation).
- **Shard lease** — a heartbeated Postgres row granting an instance ownership of a shard.
- **Reconcile** — converge actual Discord state to expected DB state (on reconnect or via sweep).
- **Entitlement** — per-guild auth state (`trial`/`active`/`expired`/`blocked`); bypassed when `SELF_HOSTED`.
- **Circuit-breaker** — per-guild guard that halts processing for a repeatedly-failing guild.
