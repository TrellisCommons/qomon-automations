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
  /** The hard stop on Qomon writes. Set to `true` on the droplet only, so a
   *  database copied from production cannot write from anywhere else. */
  QOMON_WRITES_ALLOWED: booleanFlag,
  /** Circuit breaker: a run that plans more writes than this writes nothing. */
  MAX_WRITES_PER_RUN: z.coerce.number().int().positive().default(500),
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
