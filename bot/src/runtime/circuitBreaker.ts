/**
 * Per-guild circuit breaker. Halts processing for a repeatedly-failing guild so
 * one bad guild cannot endlessly churn or amplify load, while leaving every
 * other guild unaffected.
 *
 * States:
 * - `closed`    — normal; failures are counted.
 * - `open`      — tripped; calls are rejected until the cooldown elapses.
 * - `half-open` — probing; a single trial is allowed. Success closes it, failure
 *                 re-opens it.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures before the breaker trips open. */
  failureThreshold?: number;
  /** Cooldown (ms) before an open breaker moves to half-open. */
  cooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Circuit is open; retry after ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  getState(): CircuitState {
    return this.peekState();
  }

  /** Returns the effective state, accounting for elapsed cooldown. */
  private peekState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      return 'half-open';
    }
    return this.state;
  }

  /** Throws {@link CircuitOpenError} if calls are not currently permitted. */
  assertCanProceed(): void {
    const state = this.peekState();
    if (state === 'open') {
      const retryAfter = this.cooldownMs - (this.now() - this.openedAt);
      throw new CircuitOpenError(Math.max(0, retryAfter));
    }
    // Promote a cooled-down breaker so the next call is the half-open trial.
    if (this.state === 'open' && state === 'half-open') {
      this.state = 'half-open';
    }
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure(): void {
    if (this.peekState() === 'half-open') {
      // A failed probe re-opens immediately.
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
  }
}
