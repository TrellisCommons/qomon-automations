import { QomonError, QomonRateLimitError } from './errors.js';

export interface BackoffOptions {
  retries: number;
  baseMs: number;
  maxMs: number;
  /** 0..1 fraction of the delay applied as random jitter. */
  jitter?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(error: unknown): boolean {
  if (error instanceof QomonError) return error.retryable;
  // Undici / fetch network errors surface as TypeError('fetch failed').
  return error instanceof TypeError;
}

/**
 * Retry `fn` with exponential backoff on retryable failures (5xx, 429,
 * transport). Non-retryable Qomon errors (auth, validation, not-found) throw
 * immediately. A {@link QomonRateLimitError} with `retryAfterMs` overrides the
 * computed delay.
 */
export async function withBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: BackoffOptions,
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const jitter = opts.jitter ?? 0.2;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt > opts.retries || !isRetryable(error)) throw error;
      const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** (attempt - 1));
      const jittered = exp * (1 - jitter + random() * jitter * 2);
      const delayMs =
        error instanceof QomonRateLimitError && error.retryAfterMs != null
          ? Math.max(error.retryAfterMs, jittered)
          : jittered;
      opts.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
