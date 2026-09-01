import { Status } from 'discord.js';
import type { SubsystemStatus } from '../ops/health.js';

/**
 * The gateway subsystem for `/health`, derived per shard on every call.
 *
 * **Why this is not a variable.** It used to be one: set `up` once on
 * `clientReady`, and set `down` only by a client-level `error` event. A shard
 * that disconnects and wedges in `Connecting` fires neither, so `/health`
 * reported `up` for as long as the process lived.
 *
 * That is exactly what happened on 2026-09-01. Shard 0 sat in `Connecting` for
 * 3 hours 37 minutes, serving roughly 1,390 guilds nothing, while `/health`
 * returned 200 with `gateway: "up"`, Fly's ten-second check stayed green, and
 * `fly status` showed four healthy machines. The `gateway.down` alert condition
 * detected it correctly and confirmed it 217 times. Every human-facing signal
 * stayed green.
 *
 * **Read the shards, never the aggregates.** `watchChecks.ts` documents the same
 * trap at its `gateway.down` condition: discord.js latches both
 * `client.ws.status` and `isReady()` and never resets either on a disconnect, so
 * the per-shard loop is the only thing that tells the truth. `/health` and the
 * alerting now read the same source, which is the point: a detector that fires
 * while the health endpoint says everything is fine is worse than no detector,
 * because the health endpoint is what a human checks first.
 */
export interface GatewayHealthDeps {
  /** `client.readyAt`. Non-null once the gateway has ever reached ready. */
  readyAt: () => Date | null;
  /** `client.ws.shards` statuses, in any order. */
  shardStatuses: () => number[];
  now?: () => number;
  /**
   * How long a shard may sit non-Ready before this reports `down`.
   *
   * A resume takes seconds, and reporting down for one would have Fly pull a
   * healthy machine out of rotation on every ordinary blip, which is a worse
   * failure than the one this exists to catch. Two minutes is past anything
   * discord.js recovers from on its own, and matches the two confirmations the
   * `gateway.down` alert needs before it wakes anyone.
   */
  graceMs?: number;
  /**
   * How long a process may go without ever reaching its first ready before this
   * reports `down` anyway.
   *
   * **The pre-ready state needs a bounded life, because otherwise it is a second
   * copy of the bug this file exists to fix.** `unknown` is not `down`, so a
   * shard that wedges in `Connecting` on a NEW connection rather than on a resume
   * never reaches ready, `hasBeenReady` stays false forever, and every signal
   * reports a healthy booting machine for as long as the process lives. Worse,
   * `client.login()` does not resolve until every shard is ready, so nothing
   * after it in boot ever runs.
   *
   * Ten minutes is far past any real boot (a fleet-wide start is measured at
   * 50-100s fully dark) and well past Fly's own 30s health-check grace, so the
   * deploy gate is unaffected either way.
   */
  bootDeadlineMs?: number;
}

export const GATEWAY_GRACE_MS = 120_000;
export const GATEWAY_BOOT_DEADLINE_MS = 10 * 60_000;

export function createGatewayHealth(deps: GatewayHealthDeps): () => SubsystemStatus {
  const now = deps.now ?? (() => Date.now());
  const graceMs = deps.graceMs ?? GATEWAY_GRACE_MS;
  const bootDeadlineMs = deps.bootDeadlineMs ?? GATEWAY_BOOT_DEADLINE_MS;
  /** Latched: "not connected yet" and "disconnected" are different answers. */
  let hasBeenReady = false;
  let unhealthySince: number | null = null;
  const createdAt = now();

  return () => {
    if (deps.readyAt() !== null) hasBeenReady = true;
    // Before the first ready this is a booting machine, not a broken one, until
    // it has been booting for longer than any boot takes. Fly's own grace period
    // covers the normal window.
    if (!hasBeenReady) return now() - createdAt >= bootDeadlineMs ? 'down' : 'unknown';

    const statuses = deps.shardStatuses();
    const allReady = statuses.length > 0 && statuses.every((status) => status === Status.Ready);
    if (allReady) {
      unhealthySince = null;
      return 'up';
    }

    unhealthySince ??= now();
    return now() - unhealthySince >= graceMs ? 'down' : 'up';
  };
}
