import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Logger } from '@avc/core';

export type SubsystemStatus = 'up' | 'down' | 'unknown';

export interface HealthReport {
  /**
   * Overall readiness — `up` if every critical subsystem is `up`, OR if the
   * instance is deliberately `idle` (see below) and doing exactly what it
   * should. `/health`'s HTTP status is this field, verbatim (`200` for `up`,
   * `503` otherwise) — it is what gates a Fly rolling deploy, not a
   * documentation nicety, so an idle instance must report `up` here or a
   * deploy can stall waiting for a health check that is never meant to pass.
   */
  status: SubsystemStatus;
  subsystems: {
    gateway: SubsystemStatus;
    leases: SubsystemStatus;
    db: SubsystemStatus;
  };
  version: string;
  commit: string;
  instanceId: string;
  /**
   * True for an instance holding zero shard leases *by design* — an
   * over-provisioned fleet, or a spare machine ahead of a config change
   * (`plans/scaling.md` §9). `subsystems.leases` still reads `down` (that
   * part is a fact), but `status` reads `up` regardless, specifically so
   * this case doesn't collide with a genuinely broken instance failing to
   * hold leases it's supposed to. Absent (not merely `false`) on the normal
   * path, so a reader can tell "never idle" from "not idle right now".
   */
  idle?: true;
}

export interface DiagnosticsReport {
  instanceId: string;
  version: string;
  commit: string;
  claimedShards: number[];
  queueDepth: number;
  trippedCircuits: number;
  queues: { guildId: string; depth: number; circuitState: string }[];
  recentErrors: unknown[];
  /** Whether the global-pause kill-switch is set. */
  paused: boolean;
  /** Current snapshot of the DB-backed runtime control-plane flags. */
  runtimeFlags: Record<string, unknown>;
  /** Whether the periodic safety-net sweep is currently running. */
  sweepEnabled: boolean;
  /** Billing/trial reconcile job counters (null when SELF_HOSTED). */
  billing: Record<string, unknown> | null;
  /**
   * `/templateassistant` counters, including the fleet-wide estimated spend for
   * the current month against its ceiling. Null when no model endpoint is
   * configured (the self-host default).
   */
  ai: Record<string, unknown> | null;
  /**
   * Scheduled-backup state (`plans/backups.md` §8). `{ enabled: false }` when no
   * storage is configured, which is the self-host default.
   *
   * Reported here rather than in `/health` on purpose: `stale` is informational
   * and **must never gate a deploy**. A backup that has not run is a reason to
   * alert a human, never a reason to block a rollout that might be the fix.
   */
  backup: Record<string, unknown>;
  /**
   * Guild-facing permission-problem notices: attempted, where they landed, and
   * what suppressed the rest.
   *
   * The only outbound sender that talks to customers unprompted, so "too
   * chatty" and "reaching nobody" both have to be answerable from here rather
   * than from a complaint. A high `undeliverable` against a healthy
   * `attempted` is a fleet-wide delivery problem, not a quiet week.
   */
  problems: Record<string, unknown>;
  /**
   * Supporter-role assignment in the support guild. `{ enabled: false }` when
   * no support guild is configured, which is every self-host and the fleet that
   * is not given the env.
   *
   * `owned` is the field to read first: it is false on every instance except
   * the one whose shard serves the support guild, so a fleet-wide sweep of
   * `/diagnostics` shows exactly one machine doing this work. `unusableRoles`
   * answers the failure that otherwise looks identical to the feature being
   * switched off.
   */
  supporterRoles: Record<string, unknown>;
}

export interface HealthServerOptions {
  port: number;
  logger: Logger;
  /** Returns the current per-subsystem health report. */
  health: () => HealthReport;
  /** Returns the current read-only diagnostics snapshot (may be async). */
  diagnostics: () => DiagnosticsReport | Promise<DiagnosticsReport>;
  /**
   * Bearer token required on `/diagnostics`. Undefined leaves it open, which
   * is only reachable on a self-host: the config schema refuses to start a
   * hosted instance (`SELF_HOSTED=false`) without one.
   */
  diagnosticsToken?: string | undefined;
}

/**
 * Constant-time token comparison.
 *
 * Hashed first so both sides are always 32 bytes: `timingSafeEqual` throws on
 * a length mismatch, and that throw would itself leak the token's length.
 */
function tokenMatches(expected: string, provided: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}

/** The bearer token on a request, if it carries one. */
function bearerFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Read-only HTTP endpoint for operability: `/health` (readiness, per subsystem,
 * for the deploy gate) and `/diagnostics` (live state for debugging-by-query).
 * Intentionally dependency-free.
 */
export class HealthServer {
  private server: Server | undefined;
  private readonly options: HealthServerOptions;

  constructor(options: HealthServerOptions) {
    this.options = options;
  }

  /** The actual bound TCP port once started (useful when port 0 was requested). */
  get boundPort(): number | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : undefined;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        const url = req.url ?? '/';
        if (url === '/health' || url === '/healthz') {
          const report = this.options.health();
          this.json(res, report.status === 'up' ? 200 : 503, report);
          return;
        }
        if (url === '/diagnostics') {
          const expected = this.options.diagnosticsToken;
          if (expected) {
            const provided = bearerFrom(req);
            if (!provided || !tokenMatches(expected, provided)) {
              // 404, not 401: a 401 confirms the endpoint exists and invites
              // guessing. An unauthorized caller should not be able to tell
              // this route apart from any other path on the server.
              this.json(res, 404, { error: 'not found' });
              return;
            }
          }
          void Promise.resolve(this.options.diagnostics())
            .then((report) => this.json(res, 200, report))
            .catch((err: unknown) => {
              this.options.logger.error({ err }, 'diagnostics failed');
              this.json(res, 500, { error: 'diagnostics failed' });
            });
          return;
        }
        this.json(res, 404, { error: 'not found' });
      });
      this.server.listen(this.options.port, () => {
        this.options.logger.info({ port: this.options.port }, 'health server listening');
        resolve();
      });
    });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = undefined;
  }
}
