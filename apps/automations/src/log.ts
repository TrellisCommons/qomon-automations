import { pino, type Logger } from 'pino';

/** JSON lines on stdout (journald on the droplet). IDs and counts only:
 *  never a name, address, or other contact data. */
export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return pino({ level: process.env.LOG_LEVEL ?? 'info' }).child(bindings);
}

export type { Logger };
