import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '@avc/core';

export type SubsystemStatus = 'up' | 'down' | 'unknown';

export interface HealthReport {
  /** Overall readiness — `up` only if every critical subsystem is `up`. */
  status: SubsystemStatus;
  subsystems: {
    gateway: SubsystemStatus;
    leases: SubsystemStatus;
    db: SubsystemStatus;
  };
  version: string;
  commit: string;
  instanceId: string;
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
}

export interface HealthServerOptions {
  port: number;
  logger: Logger;
  /** Returns the current per-subsystem health report. */
  health: () => HealthReport;
  /** Returns the current read-only diagnostics snapshot (may be async). */
  diagnostics: () => DiagnosticsReport | Promise<DiagnosticsReport>;
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
