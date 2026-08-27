# Auto Voice Channels

A Discord bot that creates a voice channel the moment someone joins your creator
channel, and deletes it when the last person leaves. Room names, user limits,
permissions and privacy are all configurable, per server and per room.

**License: AGPL-3.0-only.** The [hosted service](https://auto-voice.io) runs this
exact code, so self-hosting gets you the whole bot, not a community edition.

> Looking for the Python bot? It is unmaintained, but still on the
> [`master`](https://github.com/GregZaal/Auto-Voice-Channels/tree/master) branch
> under the MIT license. This branch is the TypeScript rewrite that replaces it.

## Self-host it

You need Docker, Docker Compose, and a free Discord application.

1. Create an application in the
   [Discord Developer Portal](https://discord.com/developers/applications). Copy
   the token from **Bot** and the application id from **General Information**,
   then turn on both privileged intents (**Server Members** and **Presence**).
   Presence is what lets room names follow the game people are playing.
2. Clone, configure, run:

   ```bash
   git clone https://github.com/GregZaal/Auto-Voice-Channels.git
   cd Auto-Voice-Channels
   cp .env.example .env     # set DISCORD_TOKEN and CLIENT_ID
   docker compose up -d
   ```

That is the whole setup. Postgres starts alongside the bot, migrations run on
boot, slash commands register themselves, and trials, billing and paywalls do not
apply to a self-hosted instance.

**[Full self-hosting guide](https://auto-voice.io/docs/self-hosting)**, including
how much hardware your member count needs.

## Docs

- [Getting started](https://auto-voice.io/docs/getting-started): `/setup` and
  your first creator channel
- [Commands](https://auto-voice.io/docs/commands)
- [Name templates](https://auto-voice.io/docs/name-templates): numbering, game
  names, rich presence, conditionals
- [Template assistant](https://auto-voice.io/docs/template-assistant): describe
  the names you want in plain language, using any OpenAI-compatible key
- [Troubleshooting](https://auto-voice.io/docs/troubleshooting)

## Day two

`.env.example` documents every optional variable. Two are worth setting now:
`ADMIN_CHANNEL_ID`, where the bot posts errors it could not handle, and
`WATCHDOG_PING_URL`, which is how you find out it has stopped.

- **Health.** `http://localhost:8477/health` reports per subsystem (database,
  shard leases, gateway), and `/diagnostics` gives live state. Compose maps 8477
  to the container's 8080, to stay clear of whatever else is on 8080 already.
- **Updates.** `git pull && docker compose up -d --build`. Migrations only ever
  add before they remove, so upgrading is safe.
- **Your data** is the `pgdata` Docker volume: settings, templates, aliases and
  every channel being tracked. It survives `docker compose down`, and does not
  survive `docker compose down -v`.

### Backups

Set the five `BACKUP_S3_*` variables and the bot dumps Postgres on a schedule,
encrypts it, uploads it to any S3-compatible bucket, prunes old copies, and
re-checks the newest one every week. No extra container and no cron. Set
`BACKUP_ENCRYPTION_KEY` too, then keep a copy of it somewhere other than the
machine it protects: without the key nobody can recover those backups, including
you.

```bash
docker compose exec bot node core/dist/backup/cli.js list    # what exists
docker compose exec bot node core/dist/backup/cli.js drill   # is the newest one restorable
```

Restoring drops and recreates tables the running bot holds locks on, so stop it
first. `--force` is required to write over a database that already has tables,
and `--at <ISO timestamp>` restores the newest backup at or before a moment
instead of the latest.

```bash
docker compose stop bot
docker compose run --rm bot node core/dist/backup/cli.js restore --force
docker compose start bot
```

## Development

Node 22 LTS, pnpm via corepack, and Docker for the integration tests, which run
against a real ephemeral Postgres so advisory locks, `LISTEN/NOTIFY` and
transactions are exercised for real.

```bash
corepack enable && pnpm install
pnpm run typecheck && pnpm run lint && pnpm run test
pnpm run test:unit    # business logic only, no Docker needed
```

[`core/`](./core) holds domain logic, the Drizzle schema, types and validation.
[`bot/`](./bot) holds the gateway runtime, shard leases, the dispatcher, features
and ops. [`deploy/fly/`](./deploy/fly) is the hosted service's config.

Postgres is the source of truth, and every state-changing operation is
idempotent. Coordination uses native Postgres primitives (advisory locks,
`LISTEN/NOTIFY`, heartbeated shard leases) rather than Redis. Work is queued per
guild, which buys ordering, fault isolation and a per-guild circuit breaker, and
reconciliation converges instead of duplicating channels. Migrations follow
strict expand/contract (add columns and tables first, drop only in a later
release) and apply on boot, with
`pnpm --filter @avc/core run db:generate` to write one from schema changes.

## Help

[Support server](https://discord.gg/HT6GNhJ), or open an issue.
