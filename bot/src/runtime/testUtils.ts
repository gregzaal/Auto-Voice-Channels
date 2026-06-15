import type { Logger } from '@avc/core';

/**
 * A no-op logger satisfying the pino `Logger` shape, for unit tests that need to
 * pass a logger but don't assert on log output.
 */
export function fakeLogger(): Logger {
  const logger: Record<string, unknown> = {};
  const noop = (): void => {};
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    logger[level] = noop;
  }
  logger.child = () => logger;
  return logger as unknown as Logger;
}
