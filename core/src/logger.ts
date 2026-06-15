import { randomUUID } from 'node:crypto';
import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/**
 * Structured logging (pino/JSON). Logs should always carry a correlation id and,
 * where applicable, a guild id so a single operation is traceable end-to-end.
 */
export interface LoggerConfig {
  level?: LoggerOptions['level'];
  /** Pretty-print for local dev; JSON otherwise. */
  pretty?: boolean;
  base?: Record<string, unknown>;
}

export function createLogger(config: LoggerConfig = {}): Logger {
  const options: LoggerOptions = {
    level: config.level ?? 'info',
    base: { ...config.base },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (config.pretty) {
    return pino({
      ...options,
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  }
  return pino(options);
}

/** Generates a new correlation id for threading through an operation. */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Returns a child logger bound to a correlation id (and optional guild id) so
 * every downstream log line for one operation can be filtered together.
 */
export function withCorrelation(logger: Logger, correlationId: string, guildId?: string): Logger {
  const bindings: Record<string, unknown> = { correlationId };
  if (guildId !== undefined) bindings.guildId = guildId;
  return logger.child(bindings);
}
