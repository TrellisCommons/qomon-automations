/**
 * Client-side self-throttle (data-model §4): Qomon documents no rate limits,
 * so the client paces itself. Default 5 rps (PRD §6); raise once real limits
 * are measured (R2). Also bounds concurrency so a burst of callers cannot
 * stampede.
 */

export interface RateLimiterOptions {
  /** Requests per second. */
  rps: number;
  /** Max in-flight requests. */
  concurrency?: number;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RateLimiter {
  private readonly minSpacingMs: number;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private nextSlot = 0;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(opts: RateLimiterOptions) {
    if (opts.rps <= 0) throw new RangeError('rps must be > 0');
    this.minSpacingMs = 1000 / opts.rps;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private async acquireSlot(): Promise<void> {
    if (this.inFlight >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight += 1;
    const now = this.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minSpacingMs;
    if (wait > 0) await this.sleep(wait);
  }

  private releaseSlot(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }

  /** Delay all future scheduling by `ms` (used on a 429 / rate-limit signal). */
  penalize(ms: number): void {
    this.nextSlot = Math.max(this.nextSlot, this.now() + ms);
  }
}
