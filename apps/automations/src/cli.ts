import { parseArgs } from 'node:util';
import { loadEnv, requireSecretKey, type Env } from './env.js';
import { getPrisma, type PrismaClient } from './db.js';
import {
  runHouseholdMatch,
  UsageError,
  type RunResult,
} from './jobs/household-match/run.js';
import { resolvePresenceConfig } from './jobs/household-match/presence.js';
import { tryAdvisoryLock } from './lock.js';
import { createLogger } from './log.js';
import { pingHealthcheck, postSlack } from './notify/slack.js';
import { writeRunReport } from './report.js';
import {
  getSpace,
  qomonFor,
  redact,
  saveSpace,
  setWritesEnabled,
} from './spaces/spaces.js';

const USAGE = `Usage: pnpm job <command> [options]

  household-match --space <key> [--apply] [--backfill] [--max-writes <n>] [--report <file.csv>]
      Fetch the space, plan, and (with --apply, when the environment and the
      space allow writes) write and verify. Without --apply it is a dry run.
      --backfill marks a one-off catch-up run; applying one needs --max-writes.

  report --run <id> --out <file.csv>     A run's planned writes (contact ids only)
  space:add --key <key> --name <name> --canvassed <v1,v2,...> --household-value <v>
            [--municipality <city>] [--active-until <ISO date>] [--api-base <url>]
      Create or update a space. A new space reads its Qomon API key from stdin.
  space:check --key <key>                Read-only: check the config against Qomon's Presence form
  space:show --key <key>                 Print a space's config (never its API key)
  space:writes --key <key> (--on|--off) --reason <text>
`;

/** Exit codes: 0 done (or nothing to do), 1 failed, 2 a circuit breaker tripped. */
function exitCodeFor(result: RunResult): number {
  if (result.status === 'FAILED') return 1;
  if (result.status === 'TRIPPED') return 2;
  return 0;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function actorName(): string {
  return process.env.SUDO_USER ?? process.env.USER ?? 'cli';
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      space: { type: 'string' },
      key: { type: 'string' },
      apply: { type: 'boolean', default: false },
      backfill: { type: 'boolean', default: false },
      'max-writes': { type: 'string' },
      report: { type: 'string' },
      run: { type: 'string' },
      out: { type: 'string' },
      name: { type: 'string' },
      canvassed: { type: 'string' },
      'household-value': { type: 'string' },
      municipality: { type: 'string' },
      'active-until': { type: 'string' },
      'api-base': { type: 'string' },
      on: { type: 'boolean', default: false },
      off: { type: 'boolean', default: false },
      reason: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (!command || values.help) {
    process.stdout.write(USAGE);
    return command ? 0 : 64;
  }

  const env = loadEnv();
  const prisma = getPrisma();
  try {
    switch (command) {
      case 'household-match':
        return await householdMatch(env, prisma, values);
      case 'report': {
        if (!values.run || !values.out)
          throw new UsageError('report needs --run and --out');
        const n = await writeRunReport(prisma, values.run, values.out);
        console.log(`wrote ${n} rows to ${values.out}`);
        return 0;
      }
      case 'space:add': {
        const key = values.key;
        if (!key || !values.name || !values['household-value']) {
          throw new UsageError(
            'space:add needs --key, --name, --canvassed, and --household-value',
          );
        }
        const space = await saveSpace(
          prisma,
          requireSecretKey(env),
          {
            key,
            name: values.name,
            qomonApiKey: (await readStdin()) || undefined,
            qomonApiBase: values['api-base'] ?? null,
            municipality: values.municipality ?? null,
            activeUntil: values['active-until']
              ? new Date(values['active-until'])
              : null,
            canvassedValues: list(values.canvassed),
            householdValue: values['household-value'],
          },
          actorName(),
        );
        console.log(JSON.stringify(redact(space), null, 2));
        return 0;
      }
      case 'space:show': {
        console.log(
          JSON.stringify(
            redact(await getSpace(prisma, required(values.key, '--key'))),
            null,
            2,
          ),
        );
        return 0;
      }
      case 'space:check': {
        const space = await getSpace(prisma, required(values.key, '--key'));
        const forms = await qomonFor(
          space,
          env,
          requireSecretKey(env),
        ).listFormsByType('presence_status');
        console.log(
          'Presence values:',
          forms.flatMap((f) => f.refvalues.map((r) => r.value)).join(', '),
        );
        resolvePresenceConfig(
          forms,
          space.canvassedValues,
          space.householdValue,
        );
        console.log(
          `space ${space.key}: canvassed values and household value are on the Presence form`,
        );
        return 0;
      }
      case 'space:writes': {
        if (values.on === values.off)
          throw new UsageError(
            'space:writes needs exactly one of --on and --off',
          );
        const space = await setWritesEnabled(
          prisma,
          env,
          required(values.key, '--key'),
          values.on,
          {
            actor: actorName(),
            reason: required(values.reason, '--reason'),
          },
        );
        console.log(
          `space ${space.key}: writes ${space.writesEnabled ? 'on' : 'off'}`,
        );
        return 0;
      }
      default:
        throw new UsageError(`unknown command ${JSON.stringify(command)}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new UsageError(`${flag} is required`);
  return value;
}

async function householdMatch(
  env: Env,
  prisma: PrismaClient,
  values: {
    space?: string;
    apply: boolean;
    backfill: boolean;
    'max-writes'?: string;
    report?: string;
  },
): Promise<number> {
  const maxWrites =
    values['max-writes'] === undefined
      ? undefined
      : Number(values['max-writes']);
  if (
    maxWrites !== undefined &&
    !(Number.isInteger(maxWrites) && maxWrites > 0)
  ) {
    throw new UsageError('--max-writes must be a positive integer');
  }
  const secretKey = requireSecretKey(env);
  const log = createLogger();
  let result: RunResult | undefined;
  try {
    result = await runHouseholdMatch(
      {
        prisma,
        env,
        log,
        qomonFor: (space) => qomonFor(space, env, secretKey),
        lock: (name) => tryAdvisoryLock(env.DATABASE_URL, name),
        notify: (text) => postSlack(env, text),
      },
      {
        spaceKey: required(values.space, '--space'),
        apply: values.apply,
        backfill: values.backfill,
        maxWrites,
      },
    );
    if ('runId' in result) {
      console.log(
        JSON.stringify({
          runId: result.runId,
          status: result.status,
          applying: result.applying,
          ...result.stats,
        }),
      );
      if (values.report) {
        const n = await writeRunReport(prisma, result.runId, values.report);
        console.log(`wrote ${n} rows to ${values.report}`);
      }
    }
    return exitCodeFor(result);
  } finally {
    const ok = result !== undefined && exitCodeFor(result) === 0;
    await pingHealthcheck(env, ok).catch((err) =>
      log.warn({ err: String(err) }, 'health check ping failed'),
    );
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    if (err instanceof UsageError) process.stderr.write('\n' + USAGE);
    process.exit(err instanceof UsageError ? 64 : 1);
  },
);
