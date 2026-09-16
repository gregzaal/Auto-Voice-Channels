import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@avc/core';
import { connectGateway } from './gatewayLogin.js';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => logger,
} as unknown as Logger;

/**
 * A fake timer that fires when the test says so, so "three minutes later" costs
 * nothing. `setTimeout` here is only ever used for the boot window.
 */
function manualTimer() {
  let fire: (() => void) | undefined;
  return {
    setTimeoutFn: ((fn: () => void) => {
      fire = fn;
      return { unref: () => {} } as never;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {
      fire = undefined;
    }) as unknown as typeof clearTimeout,
    elapse: () => fire?.(),
    armed: () => fire !== undefined,
  };
}

describe('connectGateway', () => {
  it('resolves connected when login resolves', async () => {
    const timer = manualTimer();
    const outcome = await connectGateway({
      login: () => Promise.resolve(),
      logger,
      report: () => {},
      ...timer,
    });
    expect(outcome).toBe('connected');
    // The boot window is cancelled, so nothing reports a slow boot afterwards.
    expect(timer.armed()).toBe(false);
  });

  /**
   * `beta`, 2026-09-15. A shard wedged on its first connect and `login()` never
   * settled; everything after the await in boot - the drain handler, the
   * metrics collector, the watchdog ping - was never started, for seventeen
   * hours, while the bot itself worked.
   */
  it('lets boot continue when login never settles', async () => {
    const timer = manualTimer();
    const report = vi.fn();
    const gate = connectGateway({
      login: () => new Promise(() => {}),
      logger,
      report,
      ...timer,
    });
    timer.elapse();
    expect(await gate).toBe('pending');
    expect(report).toHaveBeenCalledWith(
      'gateway.boot_slow',
      expect.any(String),
      expect.objectContaining({ waitedMs: expect.any(Number) }),
    );
  });

  /**
   * `prod`, the same outage. `login()` rejected, `main()` rejected with it, the
   * process exited 1, and Fly spent all ten restart retries inside the outage
   * window - after which nothing ever tried again.
   */
  it('lets boot continue when login rejects, and keeps retrying', async () => {
    const timer = manualTimer();
    const report = vi.fn();
    const attempts: number[] = [];
    let attempt = 0;
    const gate = connectGateway({
      login: () => {
        attempt += 1;
        attempts.push(attempt);
        return attempt < 3
          ? Promise.reject(new Error('503 service unavailable'))
          : Promise.resolve();
      },
      logger,
      report,
      retryDelayMs: 0,
      sleep: () => Promise.resolve(),
      ...timer,
    });
    expect(await gate).toBe('retrying');
    // The boot window is cancelled with it: left armed it would report a slow
    // boot three minutes after boot had already continued.
    expect(timer.armed()).toBe(false);
    await vi.waitFor(() => expect(attempts.length).toBe(3));
    // Reported once for the episode, not once per attempt: `gateway.down` owns
    // the condition from there, and it resolves itself.
    expect(report.mock.calls.filter((c) => c[0] === 'gateway.login_failed')).toHaveLength(1);
    expect(report.mock.calls.filter((c) => c[0] === 'gateway.connected')).toHaveLength(1);
  });

  /**
   * `beta`'s shape: the first connect fails, the websocket layer's own
   * reconnect brings the shard back underneath, and logging in again would be
   * refused by `@discordjs/ws` as an attempt to connect a shard that is not
   * idle -- an unhandled rejection, and an attempt that never settles.
   */
  it('stops retrying once the websocket layer has connected on its own', async () => {
    const timer = manualTimer();
    let connected = false;
    let attempts = 0;
    await connectGateway({
      login: () => {
        attempts += 1;
        connected = true;
        return Promise.reject(new Error('handshake failed'));
      },
      hasConnected: () => connected,
      logger,
      report: () => {},
      sleep: () => Promise.resolve(),
      ...timer,
    });
    await vi.waitFor(() => expect(timer.armed()).toBe(false));
    expect(attempts).toBe(1);
  });

  it('backs off between attempts, up to a ceiling', async () => {
    const timer = manualTimer();
    const slept: number[] = [];
    let attempt = 0;
    await connectGateway({
      login: () => {
        attempt += 1;
        return attempt < 5 ? Promise.reject(new Error('nope')) : Promise.resolve();
      },
      logger,
      report: () => {},
      retryDelayMs: 100,
      maxRetryDelayMs: 300,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      ...timer,
    });
    await vi.waitFor(() => expect(attempt).toBe(5));
    expect(slept).toEqual([100, 200, 300, 300]);
  });

  /**
   * A bad token must stay fatal. Retrying it forever produces a machine that
   * looks alive, serves nothing and never says why - the same invisible failure
   * this file exists to remove, with a different cause.
   */
  it('rejects rather than retrying an invalid token', async () => {
    const timer = manualTimer();
    let attempts = 0;
    await expect(
      connectGateway({
        login: () => {
          attempts += 1;
          return Promise.reject(new Error('An invalid token was provided.'));
        },
        logger,
        report: () => {},
        sleep: () => Promise.resolve(),
        ...timer,
      }),
    ).rejects.toThrow('invalid token');
    expect(attempts).toBe(1);
  });

  it('treats a 401 as fatal too', async () => {
    const timer = manualTimer();
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    await expect(
      connectGateway({
        login: () => Promise.reject(err),
        logger,
        report: () => {},
        sleep: () => Promise.resolve(),
        ...timer,
      }),
    ).rejects.toThrow('Unauthorized');
  });
});
