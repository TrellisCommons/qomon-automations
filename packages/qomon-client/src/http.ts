import { z } from 'zod';
import { withBackoff } from './backoff.js';
import {
  QomonMalformedResponseError,
  QomonRateLimitError,
  QomonTransportError,
  classifyHttpError,
  type QomonErrorContext,
} from './errors.js';
import { RateLimiter } from './throttle.js';

export interface QomonHttpOptions {
  baseUrl?: string;
  apiKey: string;
  /** self-throttle rps (default 5). */
  rps?: number;
  concurrency?: number;
  retries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

export interface RequestOptions<T extends z.ZodTypeAny> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Schema for the `data` field of the success envelope. */
  schema: T;
}

const DEFAULT_BASE_URL = 'https://incoming.qomon.app';

export class QomonHttp {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly retries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(opts: QomonHttpOptions) {
    if (!opts.apiKey) throw new Error('QomonHttp requires an apiKey');
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.retries = opts.retries ?? 4;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 15_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.limiter = new RateLimiter({
      rps: opts.rps ?? 5,
      concurrency: opts.concurrency,
      now: opts.now,
      sleep: opts.sleep,
    });
  }

  async request<T extends z.ZodTypeAny>(
    opts: RequestOptions<T>,
  ): Promise<{ data: z.infer<T>; total?: number }> {
    const url = new URL(this.baseUrl + opts.path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    return withBackoff(
      async (attempt) => {
        const ctx: QomonErrorContext = {
          method: opts.method,
          path: opts.path,
          attempt,
        };
        return this.limiter.schedule(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.timeoutMs);
          let res: Response;
          try {
            res = await this.fetchImpl(url, {
              method: opts.method,
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                Accept: 'application/json',
                ...(opts.body !== undefined
                  ? { 'Content-Type': 'application/json' }
                  : {}),
              },
              body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
              signal: controller.signal,
            });
          } catch (cause) {
            throw new QomonTransportError('Qomon request failed to send', ctx, {
              cause,
            });
          } finally {
            clearTimeout(timer);
          }

          const text = await res.text();
          const parsed = text ? safeJson(text) : undefined;

          if (!res.ok) {
            if (res.status === 429) {
              const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
              this.limiter.penalize(retryAfter ?? 5_000);
              throw new QomonRateLimitError(
                'Qomon rate limited',
                { ...ctx, httpStatus: 429, body: parsed },
                retryAfter,
              );
            }
            throw classifyHttpError(res.status, ctx, parsed);
          }

          const envelope = z
            .object({
              status: z.literal('success').optional(),
              data: z.unknown(),
              total: z.number().optional(),
            })
            .safeParse(parsed);
          if (!envelope.success) {
            throw new QomonMalformedResponseError(
              'Qomon success body was not a recognised envelope',
              { ...ctx, httpStatus: res.status, body: parsed },
            );
          }

          const data = opts.schema.safeParse(envelope.data.data);
          if (!data.success) {
            throw new QomonMalformedResponseError(
              `Qomon ${opts.method} ${opts.path} payload failed validation: ${data.error.message}`,
              { ...ctx, httpStatus: res.status, body: parsed },
            );
          }
          return { data: data.data, total: envelope.data.total };
        });
      },
      {
        retries: this.retries,
        baseMs: this.backoffBaseMs,
        maxMs: this.backoffMaxMs,
        sleep: this.sleep,
      },
    );
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}
