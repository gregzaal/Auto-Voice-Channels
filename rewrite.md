# Auto-Voice-Channels — Rewrite Plan

Notes for the rewrite of the bot from Python/discord.py into a modern, scalable
TypeScript service. The feature set is unchanged — this is a sustainability and
scalability rewrite, plus a move to the modern Discord interface (slash commands +
menus). Behaviour for individual features is **ported by referencing the existing
Python codebase**, not re-specified here.

## Goals

- One scalable app serving many thousands of guilds / millions of users.
- TypeScript, distributed across multiple instances (Fly.io), single-vendor, self-hosted.
- A **single standard bot** for all guilds — retire the multi-bot free/gold/sapphire/diamond model.
- Transactional, strongly-consistent storage with safe concurrent access.
- Event-driven, high-concurrency; resilient to gateway disconnects and missed events.
- Deploys minimize service interruption.
- Strong **per-guild isolation** — one guild's errors/bad data/abuse never affect others.
- Modern slash commands with intuitive menus.
- Test-driven: unit (logic), integration (DB), integration (Discord events).
- Monetization becomes a single paid tier with a 1-year free trial for guilds < 10k members.
  Implementation is out of scope; we only model a per-guild **auth state**.
- **Primarily agent-operated:** an AI agent handles development, deployment, live debugging,
  and maintenance. A human must remain *able* to work on and watch it, but operations are
  designed for machine consumption first (queryable state, runtime levers, safe automation).
- **Open source & self-hostable:** anyone can run a private instance via a simple, standard
  process (power users, single server, no scale needed) — using the *same* codebase as the
  scaled hosted service. Licensed **AGPL-3.0**.

## Architecture philosophy

Prefer simple, maintainable solutions. Avoid microservices, queues, or extra
infrastructure unless a requirement demonstrably needs them. A small number of
well-defined components, understandable by a small team over many years.

## Assumptions

- discord.js on Node LTS; DB is the source of truth, discord.js caches aggressively tuned/disabled.
- Self-hosted Postgres on Fly (single primary now, replica-ready); no Redis unless proven necessary.
- Single bot application/token replaces all tiers.
- Monorepo so a future dashboard reuses `core` without refactor.
- Existing per-feature behaviour is reproduced from the old code.

## Risks / things to keep visible

- **Presence intent** (game-name feature) is privileged, high-volume, and the single biggest
  scaling-cost driver. The bot must stay verified/approved for it.
- Sharding across instances is the main distributed-systems complexity.
- Gateway `RESUME` is session-bound and cannot move between machines → deploys re-identify shards.
- Missed events cause state drift (the reason the old bot polled) — reconciliation is essential.
- Single-primary Postgres is a SPOF; acceptable now, revisit if it demonstrably hurts.

## Out of scope

- Admin dashboard (architecture must *allow* it later; we don't build it now).
- Data migration from the old system (handled separately later).
- Monetization/billing implementation details.
- Any new features.

---

## Decision log

1. **Runtime & library:** discord.js on Node LTS, with caching aggressively
   tuned/disabled (DB is source of truth). Most maintainable for a small team; drop to
   `@discordjs/ws`/`@discordjs/rest` selectively only if a cache becomes a bottleneck.

2. **Shard ↔ instance topology:** Postgres-lease **dynamic shard claiming**. Total shard
   count is a managed config value; instances claim/own shards via heartbeated lease rows;
   an expired lease (dead instance) is re-claimed by another. Identify timing serialized via
   a Postgres advisory lock to respect Discord `max_concurrency`. Self-healing, no extra infra.

3. **Database:** single-primary Postgres on Fly (replica-ready), accessed via **Drizzle ORM**
   (SQL-first, typed, plays well with advisory locks / `LISTEN`-`NOTIFY` / `FOR UPDATE SKIP LOCKED`).
   Migrations via drizzle-kit.

4. **Ephemeral state & coordination:** in-process per-guild state + Postgres coordination
   (leases, `LISTEN/NOTIFY` for settings-cache invalidation and signals), behind a thin
   **swappable interface** so a shared store can be introduced later if ever needed. No Redis.

5. **Event reliability:** event-driven steady state + **reconcile-on-reconnect** (diff Discord
   state from the fresh `GUILD_CREATE` against DB expectations and converge) + a **thin
   safety-net sweep** scoped only to guilds with active managed channels, using cached state,
   tunable/disable-able. All state changes are idempotent and reconciliation convergent.

6. **Guild isolation & concurrency:** **per-guild in-memory work queues** (actor-style) —
   ordered per guild, parallel across guilds, each task fault-isolated (errors logged with
   guild context, never crash the shard or block others), per-guild circuit-breaker on repeated
   failure. DB constraints + boundary validation (zod) are the second line of defense.

7. **Deployment:** Fly rolling deploy + **graceful drain** (stop new work, finish in-flight
   per-guild queues, release leases) + lease handoff; moved shards re-identify **staggered**;
   reconcile on `READY`. Single process, no extra infra. Splitting gateway/worker for true
   zero-downtime logic deploys is a documented future lever, not built now.

8. **Project structure:** lean **monorepo** (workspaces) — `core` (domain logic, DB schema,
   types, validation) + `bot` (gateway, runtime, dispatcher, features); a future dashboard is a
   third package depending on `core`. Config from Fly secrets, **zod-validated at startup**;
   **pino** structured logging; per-instance health/metrics endpoint; errors reported to an admin
   Discord channel with a seam for a Sentry-style sink later.

9. **Testing (TDD):** **Vitest**; DB integration against **real ephemeral Postgres via
   Testcontainers** (so advisory locks / `LISTEN-NOTIFY` / `SKIP LOCKED` are tested for real);
   Discord-event integration via a **gateway-dispatch → real pipeline → fake REST/action
   recorder** harness, hardened with captured real-payload fixtures.

10. **Guild auth state:** a **status column** on the guild (fast `isEntitled(guildId)` gate:
    `trial` / `active` / `expired` / `blocked`, extensible) **+ append-only `guild_auth_events`
    audit log** (written in the same transaction) for future dashboard/support/analytics. A
    background job handles time-based transitions (e.g. trial → expired). `blocked` doubles as
    the abuse/isolation kill-switch.

11. **Command surface:** **hybrid** — direct slash commands for frequent per-channel actions
    (limit, name, lock/private, kick/transfer, …) + a **menu-driven `/settings` panel**
    (select menus / buttons / modals) for guild configuration. Global command registration;
    interactions handled over the existing gateway. Map old commands → "action" vs "config"
    by referencing the old code.

12. **Presence strategy:** keep the privileged presence intent but handle it **lazily/cheaply** —
    no presence cache; only act when a guild has an active game-templated channel; **debounce**
    renames (respect Discord's rename rate limits). Keep the bot verified for the intent.

13. **Agent-operated operations:** the system is primarily run by an AI agent, so operability is
    designed for machine consumption — queryable live state, runtime control levers, and safe
    deploy/migration automation — while remaining fully usable by a human. See the dedicated
    section below.

14. **Open source & self-hostable (single codebase):** AGPL-3.0. The scaled hosted service and a
    private self-hosted instance are the **same binary**, differentiated only by config — the
    multi-instance machinery is inert at one instance (it just claims all shards). Self-host is
    Postgres-only via Docker Compose; a `SELF_HOSTED` flag disables entitlement gating. No forked
    "lite" build, no second SQL dialect. See the dedicated section below.

---

## Target architecture

A single bot service, deployed as N identical Fly machines. Components inside each instance:

- **Shard lease manager** — claims/heartbeats/releases shard leases in Postgres; serializes
  identifies via advisory lock; reacts to scale and instance death.
- **Gateway layer (discord.js)** — owns claimed shards; minimal caches; emits raw domain events.
- **Per-guild dispatcher** — routes each event to its guild's in-memory work queue; enforces
  ordering, fault isolation, and the circuit-breaker.
- **Feature handlers** — the ported business logic (create/rename/cleanup secondaries, limits,
  privacy, votekick, transfer, aliases, etc.), gated by `isEntitled`.
- **Reconciler** — runs on shard `READY`/re-identify and as the thin scoped safety-net sweep.
- **Command/interaction layer** — slash commands + `/settings` menu components.
- **Coordination/state interface** — in-process state today, Postgres for durable/coordination.
- **Persistence (`core`)** — Drizzle schema + repositories; settings cache invalidated via `NOTIFY`.
- **Ops** — zod config, pino logging, health/metrics endpoint, admin-channel error reporting.
- **Diagnostics & control plane** — read-only introspection (HTTP + SQL views) and DB-backed
  runtime flags/kill-switches with an operational audit log (see Agent-operated operations).

### Data flow (happy path)

`Discord gateway event → gateway layer → per-guild queue (ordered, isolated) → feature handler
→ idempotent DB write + Discord action (via REST/action interface) → settings/state cache updated`

### Reliability flow

`disconnect → reconnect (RESUME if possible, else re-identify) → on READY reconcile affected
guilds (converge Discord vs DB) → resume event processing`; thin periodic sweep catches silent drops.

## Data model (high-level — finalize from old code)

Conceptual tables (names/shape to be refined in implementation):

- `guilds` — settings + `auth_status` + timestamps + `jsonb` metadata; cache-invalidated via `NOTIFY`.
- `guild_auth_events` — append-only auth-state transition log.
- `auto_channels` (primaries) — per-guild creator channels + template config.
- `secondary_channels` — bot-managed channels (owner, source primary, state) for reconciliation.
- `aliases` — per-guild game-name aliases.
- `shard_leases` — shard ownership, instance id, heartbeat, total shard count.
- `runtime_flags` — DB-backed feature flags / kill-switches the agent can toggle without a deploy.
- `ops_audit` — append-only log of operational actions (flag changes, forced reconciles, blocks).
- Supporting tables as needed (e.g. restrictions/roles) — mirror the old per-guild JSON shape.

All per-guild data keyed by `guild_id`; corrupt rows fail validation at the boundary and
quarantine to their guild without affecting others.

---

## Agent-operated operations

The system is primarily operated by an AI agent (development, deployment, live debugging,
maintenance); a human must stay able to work on and watch it. Design operability for machine
consumption first. Much of this builds directly on choices already made (Postgres-as-coordination,
idempotency, per-guild isolation, structured logging).

### 1. Introspection (debug by querying, not by dashboards)

- **Read-only diagnostics endpoint** (HTTP) per instance exposing live state: claimed shards +
  lease status, per-guild queue depths, tripped circuit-breakers, in-flight reconciles, recent
  errors, version/commit.
- **Documented SQL views** over the coordination tables (`shard_leases`, guild status, auth
  state, `ops_audit`) so the agent can inspect global state straight from Postgres.
- **Correlation/trace IDs** threaded through every event → handler → Discord-action, emitted on
  structured (pino/JSON) logs, so a single operation is traceable end-to-end.

### 2. Runtime control plane (no-deploy levers)

- **`runtime_flags`** (DB-backed) the agent can toggle live: global pause, disable/enable the
  safety-net sweep, force-reconcile a guild, block/unblock a guild, throttle channel creation.
- Every change writes to **`ops_audit`** (who/agent, what, when, why) so humans can see and
  reverse agent actions. `blocked` guild auth-state remains the per-guild kill-switch.

### 3. Deploy & migration safety automation

- **Expand/contract (backward-compatible) migrations** are mandatory — rolling deploys run old
  and new versions simultaneously, and the agent ships migrations unattended.
- **Health/readiness-gated rolling deploys with automatic rollback**; health reports per
  subsystem (gateway connected? lease held? DB reachable?) so failures are localizable.
- **Dry-run reconcile** mode: report drift without acting, for safe live diagnosis.

### 4. Guardrails (the agent's safety net)

- **Hard CI gates**: typecheck + lint + unit/integration tests must pass before deploy.
- **`AGENTS.md` runbook + diagnostics cookbook**: known failure modes, recovery procedures,
  common queries/commands, control-plane usage.
- **Reproducible builds**: pinned lockfiles + deterministic Docker image.

---

## Open source & self-hosting

License: **AGPL-3.0** (keeps modifications open; deters a closed competing hosted service).

**One codebase, two profiles, differentiated only by config.** The scaled hosted service and a
private self-hosted instance run the *same* binary. The multi-instance machinery is inert at one
instance: the shard lease manager simply claims all shards (typically just shard 0), so a
self-hoster pays no behavioural complexity cost and we maintain no forked "lite" build.

**Self-host process (standard, simple):**

- **Postgres-only**, via a provided **`docker-compose.yml`** (bot + Postgres) → `docker compose up`.
  No second SQL dialect, no SQLite/embedded path to maintain.
- **`.env`** for config (bot token, client id, optional admin/error channel), **zod-validated** at
  startup; **migrations run automatically** on boot; slash commands self-register on first start.
- **`SELF_HOSTED=true`** makes the `isEntitled` gate always allow (no trial/active/expired/billing);
  monetization concepts are simply dormant.
- Privileged intents (presence, server members) documented as a one-time dev-portal setup step.

**Keep the app deployment-agnostic:** all config via env; **Fly-specific files isolated under
`deploy/fly/`** so the application never hard-depends on Fly. Self-host uses Compose; the hosted
service uses the Fly config — same image.

**Future flexibility:** the coordination layer stays behind its swappable interface, so a lighter
single-node backend could be added later *if* self-host friction is ever demonstrated — but we do
not build or maintain a second path now.

---

## Phased implementation roadmap (TDD throughout)

Each phase: write failing tests → implement → green. Reference old code for behaviour.

1. **Foundation** — monorepo (`core`/`bot`), AGPL-3.0 license, config (zod), logging (pino) with
   correlation IDs, CI with Vitest + Testcontainers + hard typecheck/lint gates, Drizzle setup +
   first migration (expand/contract discipline), health endpoint, `docker-compose.yml` (self-host)
   + `deploy/fly/` skeleton, `AGENTS.md` + self-host README skeletons.
2. **Persistence & domain core** — guild settings + auth-state model (with `SELF_HOSTED` bypass) +
   repositories; settings cache with `NOTIFY` invalidation; `runtime_flags` + `ops_audit`. DB
   integration tests.
3. **Coordination** — shard lease manager (claim/heartbeat/release, advisory-lock identifies);
   single-instance "claims all shards" path; simulate instance death/recovery in tests.
4. **Gateway + dispatcher** — connect claimed shards, minimal caches; per-guild work queues with
   fault isolation + circuit-breaker. Gateway-dispatch/fake-REST harness.
5. **Core voice features** — primary-join → create/move/cleanup secondaries; game-name templates
   (lazy presence); the frequent per-channel actions. Port from old code, idempotent.
6. **Reconciliation** — reconcile-on-READY + thin scoped sweep + dry-run mode; drift/missed-event
   tests.
7. **Command & interaction surface** — slash commands + `/settings` menu panel; entitlement gating.
8. **Deployment & self-host** — Fly config (`deploy/fly/`), rolling deploy + graceful drain +
   lease handoff, readiness-gated with auto-rollback; verify staggered re-identify and reconcile
   under deploy. Self-host path: `docker compose up` (bot + Postgres), `SELF_HOSTED` bypass,
   auto-migrate + slash-command self-register, self-host README.
9. **Agent-operability & hardening** — diagnostics endpoint + SQL views, runtime control plane,
   abuse/rate-limit handling, error reporting, observability/metrics, diagnostics cookbook,
   load checks.

## Definition of done (per the goals)

Single bot; distributed self-healing shards; strongly-consistent Postgres; event-driven with
reconciliation; per-guild isolation; modern slash/menu UX; rolling low-interruption deploys;
unit + DB-integration + Discord-event-integration tests green; guild auth-state enforced;
AGPL-3.0 and self-hostable via `docker compose up` from the same codebase.
