import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  DATABASE_URL: z.string().url(),
  QOMON_API_BASE: z.string().url().default('https://incoming.qomon.app'),
  /** Requests per second to Qomon. Its limit is a burst of 100 refilling at
   *  10 per second (as of 2026-10), so stay under 10. */
  QOMON_RPS: z.coerce.number().positive().max(9).default(5),
  /** The hard stop on Qomon writes. Set to `true` on the droplet only, so a
   *  database copied from production cannot write from anywhere else. */
  QOMON_WRITES_ALLOWED: booleanFlag,
  /** Circuit breaker: an hourly run that plans more writes than this writes
   *  nothing and turns the space's writes off. */
  MAX_WRITES_PER_RUN: z.coerce.number().int().positive().default(500),
  /** Circuit breaker: once at least MIN_WRITES_FOR_FAILED_SHARE writes have
   *  been attempted, a larger share than this failing verification stops the
   *  run and turns the space's writes off. */
  MAX_FAILED_SHARE: z.coerce.number().min(0).max(1).default(0.2),
  MIN_WRITES_FOR_FAILED_SHARE: z.coerce.number().int().positive().default(10),
  /** How long a write may take to show up in Qomon before it counts as
   *  failed. Upserts are asynchronous and usually visible in seconds. */
  VERIFY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  /** Incremental job (docs/household-match/incremental-design.md). Each
   *  ingest re-reads this far behind the cursor, to cover search lag and
   *  clock skew; duplicates are harmless. */
  INCREMENTAL_OVERLAP_SECONDS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(120),
  /** Sanity limit for one incremental run: a plan larger than this means
   *  something is wrong, so the run writes nothing and turns writes off. */
  INCREMENTAL_MAX_WRITES_PER_RUN: z.coerce
    .number()
    .int()
    .positive()
    .default(5000),
  /** Due households one incremental run takes, oldest first; a burst
   *  drains over several runs instead of tripping the sanity limit. */
  INCREMENTAL_MAX_HOUSEHOLDS_PER_RUN: z.coerce
    .number()
    .int()
    .positive()
    .default(1000),
  /** A run that cannot write (a dry run, or writes off) re-plans a household
   *  with pending writes no sooner than this. */
  DRY_RUN_RECHECK_MINUTES: z.coerce.number().positive().default(60),
  /** A sweep that finds more contacts missing than this deletes none of
   *  them: a listing that short is more likely wrong than a mass deletion. */
  SWEEP_MAX_DELETES: z.coerce.number().int().nonnegative().default(500),
  /** A household that fails this many times is quarantined. */
  QUARANTINE_AFTER_ATTEMPTS: z.coerce.number().int().positive().default(5),
  INGEST_LAG_ALERT_MINUTES: z.coerce.number().positive().default(10),
  WORK_LAG_ALERT_MINUTES: z.coerce.number().positive().default(15),
  /** Changed contacts in one ingest above this is reported as a spike. */
  CHANGE_SPIKE_THRESHOLD: z.coerce.number().int().positive().default(5000),
  /** Contacts a sweep finds the minutely ingest missed, above which the
   *  incremental job is not to be trusted until explained. */
  SWEEP_DRIFT_THRESHOLD: z.coerce.number().int().nonnegative().default(10),
  /** 32 bytes, base64. Encrypts each space's Qomon API key at rest. */
  SPACE_SECRET_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'must be 32 bytes, base64-encoded',
    )
    .optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_CHANNEL: z.string().optional(),
  HEALTHCHECK_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // An empty value in .env means "unset", not "the empty string".
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

export function requireSecretKey(env: Env): Buffer {
  if (!env.SPACE_SECRET_KEY) {
    throw new Error(
      'SPACE_SECRET_KEY is required (32 random bytes, base64: `openssl rand -base64 32`)',
    );
  }
  return Buffer.from(env.SPACE_SECRET_KEY, 'base64');
}
