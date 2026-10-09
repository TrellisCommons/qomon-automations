import {
  QomonNotFoundError,
  collectContacts,
  type QomonApi,
} from '@trellis/qomon-client';
import { withChangeLog } from '../../changelog/write.js';
import type { Env } from '../../env.js';
import type {
  JobRun,
  Prisma,
  PrismaClient,
  RunStatus,
  Space,
} from '../../generated/prisma/index.js';
import type { HeldLock } from '../../lock.js';
import type { Logger } from '../../log.js';
import { resolveWriteMode } from '../../qomon/write-mode.js';
import { getSpace, setWritesEnabled } from '../../spaces/spaces.js';
import { householdKeyOf, planHouseholdMatch, type PlanStats } from './plan.js';
import {
  presenceOf,
  resolvePresenceConfig,
  type PresenceConfig,
} from './presence.js';

export const JOB = 'household-match';
const ACTOR = 'household-match';
const BATCH_SIZE = 20;
const VERIFY_POLL_MS = 3_000;

export interface RunOptions {
  spaceKey: string;
  /** `--apply`: write when the environment and the space allow it */
  apply: boolean;
  /** `--backfill`: a one-off catch-up run; see the runbook */
  backfill: boolean;
  /** `--max-writes`: overrides MAX_WRITES_PER_RUN; required to apply a backfill */
  maxWrites?: number;
}

export interface RunDeps {
  prisma: PrismaClient;
  env: Env;
  log: Logger;
  qomonFor(space: Space): QomonApi;
  lock(name: string): Promise<HeldLock | null>;
  notify(text: string): Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Aborting stops the run cleanly: the write in hand finishes, writes
   *  already sent are verified, and the run ends INTERRUPTED. */
  signal?: AbortSignal;
}

export interface Progress {
  /** planned writes handled so far (written, skipped, or failed) */
  done: number;
  total: number;
  perMinute: number;
  etaSeconds: number | null;
  updatedAt: string;
}

export interface RunStats extends PlanStats {
  limit: number;
  overLimit: boolean;
  skipped: number;
  applied: number;
  verified: number;
  failed: number;
  /** unverified writes of earlier, abandoned runs, settled at start */
  reconciled: number;
  progress: Progress;
}

export type RunResult =
  | { status: 'inactive' | 'locked' }
  | {
      status: RunStatus;
      runId: string;
      applying: boolean;
      stats: Partial<RunStats>;
      error?: string;
    };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export async function runHouseholdMatch(
  deps: RunDeps,
  opts: RunOptions,
): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log.child({ job: JOB, space: opts.spaceKey });
  const space = await getSpace(deps.prisma, opts.spaceKey);

  if (space.activeUntil && now() > space.activeUntil) {
    log.info(
      { activeUntil: space.activeUntil },
      'space is inactive; nothing fetched',
    );
    return { status: 'inactive' };
  }
  const mode = resolveWriteMode(deps.env, space, opts.apply);
  if (opts.backfill && mode.applying && opts.maxWrites === undefined) {
    throw new UsageError(
      'a backfill that applies needs --max-writes; take it from a dry run first',
    );
  }

  const lock = await deps.lock(`${JOB}:${space.key}`);
  if (!lock) {
    log.warn('another run holds the lock; exiting');
    return { status: 'locked' };
  }

  const run = await deps.prisma.jobRun.create({
    data: {
      job: JOB,
      spaceKey: space.key,
      kind: opts.backfill ? 'BACKFILL' : 'HOURLY',
      applying: mode.applying,
    },
  });
  const runLog = log.child({ runId: run.id });
  runLog.info(
    {
      applying: mode.applying,
      blockedBy: mode.blockedBy,
      backfill: opts.backfill,
    },
    'run started',
  );
  const stats: Partial<RunStats> = {};
  try {
    const status = await execute(
      deps,
      opts,
      space,
      run,
      mode.applying,
      stats,
      runLog,
    );
    const result = await finish(deps, run, status, stats);
    await report(deps, space, result, opts, runLog);
    return result;
  } catch (err) {
    const error =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    runLog.error({ err: error }, 'run failed');
    const result = await finish(deps, run, 'FAILED', stats, error);
    await report(deps, space, result, opts, runLog);
    return result;
  } finally {
    await lock.release();
  }
}

async function execute(
  deps: RunDeps,
  opts: RunOptions,
  space: Space,
  run: JobRun,
  applying: boolean,
  stats: Partial<RunStats>,
  log: Logger,
): Promise<RunStatus> {
  const qomon = deps.qomonFor(space);
  const presence = resolvePresenceConfig(
    await qomon.listFormsByType('presence_status'),
    space.canvassedValues,
    space.householdValue,
  );

  if (applying)
    stats.reconciled = await reconcileAbandoned(
      deps,
      qomon,
      space,
      run,
      presence,
      log,
    );

  const contacts = await collectContacts(qomon, { $all: [] });
  if (deps.signal?.aborted) return interrupt(deps, run, log);
  const plan = planHouseholdMatch(contacts, presence, space.municipality);
  const limit = opts.maxWrites ?? deps.env.MAX_WRITES_PER_RUN;
  Object.assign(stats, plan.stats, {
    limit,
    overLimit: plan.writes.length > limit,
  });
  log.info({ ...plan.stats, limit }, 'planned');

  if (plan.writes.length > 0) {
    await deps.prisma.plannedWrite.createMany({
      data: plan.writes.map((w) => ({
        runId: run.id,
        contactId: w.contactId,
        field: 'presence',
        valueBefore: null,
        valueAfter: presence.household.value,
        triggerContactId: w.triggerContactId,
        reason: `household of contact ${w.triggerContactId} (${w.triggerValue}${w.triggerDate ? ` on ${w.triggerDate.slice(0, 10)}` : ''})`,
      })),
    });
  }

  if (!applying || plan.writes.length === 0) return 'SUCCEEDED';
  if (deps.signal?.aborted) return interrupt(deps, run, log);

  if (plan.writes.length > limit) {
    if (opts.backfill) {
      log.warn(
        { planned: plan.writes.length, limit },
        'plan exceeds --max-writes; nothing written',
      );
    } else {
      await trip(
        deps,
        space,
        `run ${run.id} planned ${plan.writes.length} writes, over the limit of ${limit}`,
        log,
      );
    }
    return 'TRIPPED';
  }

  const keys = new Map(contacts.map((c) => [c.id, householdKeyOf(c)]));
  return applyAndVerify(deps, qomon, space, run, presence, keys, stats, log);
}

async function applyAndVerify(
  deps: RunDeps,
  qomon: QomonApi,
  space: Space,
  run: JobRun,
  presence: PresenceConfig,
  keys: Map<number | undefined, string | null>,
  stats: Partial<RunStats>,
  log: Logger,
): Promise<RunStatus> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const counts = { skipped: 0, applied: 0, verified: 0, failed: 0 };
  let attempted = 0;
  Object.assign(stats, counts);
  const sync = () => Object.assign(stats, counts);

  const writes = await deps.prisma.plannedWrite.findMany({
    where: { runId: run.id },
    orderBy: { contactId: 'asc' },
  });
  const mark = (
    id: string,
    status: 'SKIPPED' | 'APPLIED' | 'VERIFIED' | 'FAILED',
    detail?: string,
  ) =>
    deps.prisma.plannedWrite.update({
      where: { id },
      data: { status, detail: detail ?? null },
    });

  const startedAt = now().getTime();
  if (stats.reconciled === undefined) stats.reconciled = 0;
  await announceBackfill(deps, space, run, writes.length, log);
  let done = 0;
  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const sent: typeof writes = [];
    for (const write of writes.slice(i, i + BATCH_SIZE)) {
      if (deps.signal?.aborted) break;
      done += 1;
      // Presence is one value that an upsert replaces: re-read right before
      // writing so a visit recorded since the fetch is not overwritten.
      let current;
      try {
        current = await qomon.getContact(write.contactId);
      } catch (err) {
        if (!(err instanceof QomonNotFoundError)) throw err;
        await mark(write.id, 'SKIPPED', 'contact no longer exists');
        counts.skipped += 1;
        continue;
      }
      if (presenceOf(current, presence.form)) {
        await mark(write.id, 'SKIPPED', 'has a Presence since the fetch');
        counts.skipped += 1;
        continue;
      }
      if (householdKeyOf(current) !== keys.get(write.contactId)) {
        await mark(write.id, 'SKIPPED', 'address changed since the fetch');
        counts.skipped += 1;
        continue;
      }

      await withChangeLog(
        deps.prisma,
        { actor: ACTOR, reason: write.reason, correlationId: run.id },
        async (ctx) => {
          await ctx.tx.plannedWrite.update({
            where: { id: write.id },
            data: { status: 'APPLYING' },
          });
          await ctx.log({
            subjectType: 'QomonContact',
            subjectId: String(write.contactId),
            before: { presence: null },
            after: {
              presence: write.valueAfter,
              triggerContactId: write.triggerContactId,
            },
          });
        },
      );
      attempted += 1;
      try {
        await qomon.upsertContact({
          id: write.contactId,
          name_presences: [
            { id: presence.form.id, value: presence.household.value },
          ],
        });
        await mark(write.id, 'APPLIED');
        counts.applied += 1;
        sent.push(write);
      } catch (err) {
        await mark(
          write.id,
          'FAILED',
          err instanceof Error ? err.message : String(err),
        );
        counts.failed += 1;
      }
    }

    // Upsert answers 202 and drops bad records silently: a write counts only
    // once it is read back.
    const pending = new Map(sent.map((w) => [w.id, w]));
    const deadline = now().getTime() + deps.env.VERIFY_TIMEOUT_SECONDS * 1000;
    while (pending.size > 0) {
      for (const write of [...pending.values()]) {
        let seen;
        try {
          seen = presenceOf(
            await qomon.getContact(write.contactId),
            presence.form,
          );
        } catch (err) {
          if (!(err instanceof QomonNotFoundError)) throw err;
          pending.delete(write.id);
          await mark(
            write.id,
            'FAILED',
            'contact deleted before it could be verified',
          );
          counts.failed += 1;
          continue;
        }
        if (!seen) continue;
        pending.delete(write.id);
        if (seen.refId === presence.household.id) {
          await mark(write.id, 'VERIFIED');
          counts.verified += 1;
        } else {
          await mark(write.id, 'FAILED', 'a different Presence was recorded');
          counts.failed += 1;
        }
      }
      if (pending.size === 0) break;
      if (now().getTime() >= deadline) {
        for (const write of pending.values()) {
          await mark(
            write.id,
            'FAILED',
            `not visible after ${deps.env.VERIFY_TIMEOUT_SECONDS}s`,
          );
          counts.failed += 1;
        }
        break;
      }
      await sleep(VERIFY_POLL_MS);
    }
    sync();
    stats.progress = progressOf(done, writes.length, startedAt, now());
    await deps.prisma.jobRun.update({
      where: { id: run.id },
      data: { stats: statsJson(stats) },
    });
    log.info({ ...counts, ...stats.progress }, 'batch done');
    if (deps.signal?.aborted) return interrupt(deps, run, log);

    if (
      attempted >= deps.env.MIN_WRITES_FOR_FAILED_SHARE &&
      counts.failed / attempted > deps.env.MAX_FAILED_SHARE
    ) {
      await trip(
        deps,
        space,
        `run ${run.id}: ${counts.failed} of ${attempted} writes failed verification`,
        log,
      );
      return 'TRIPPED';
    }
  }
  return 'SUCCEEDED';
}

async function trip(
  deps: RunDeps,
  space: Space,
  reason: string,
  log: Logger,
): Promise<void> {
  log.error(
    { reason },
    'circuit breaker tripped; turning writes off for the space',
  );
  await setWritesEnabled(deps.prisma, deps.env, space.key, false, {
    actor: ACTOR,
    reason: `circuit breaker: ${reason}`,
  });
}

async function finish(
  deps: RunDeps,
  run: JobRun,
  status: RunStatus,
  stats: Partial<RunStats>,
  error?: string,
): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  await deps.prisma.jobRun.update({
    where: { id: run.id },
    data: {
      status,
      finishedAt: now(),
      stats: statsJson(stats),
      error: error ?? null,
    },
  });
  return { status, runId: run.id, applying: run.applying, stats, error };
}

/** Slack hears about a run only when something happened: writes applied, a
 *  write failed, or the run failed or tripped. Quiet hours send nothing. */
async function report(
  deps: RunDeps,
  space: Space,
  result: RunResult,
  opts: RunOptions,
  log: Logger,
): Promise<void> {
  if (!('runId' in result)) return;
  const s = result.stats;
  const eventful =
    (s.applied ?? 0) > 0 ||
    (s.failed ?? 0) > 0 ||
    result.status === 'FAILED' ||
    result.status === 'INTERRUPTED' ||
    result.status === 'TRIPPED';
  if (!eventful) return;
  const icon =
    result.status === 'SUCCEEDED' && !(s.failed ?? 0)
      ? ':white_check_mark:'
      : ':rotating_light:';
  const lines = [
    `${icon} ${JOB}${opts.backfill ? ' (backfill)' : ''} on space \`${space.key}\`: ${result.status}`,
    `planned ${s.planned ?? 0} · applied ${s.applied ?? 0} · verified ${s.verified ?? 0} · failed ${s.failed ?? 0} · skipped ${s.skipped ?? 0} · unkeyable ${s.unkeyable ?? 0}`,
    ...(result.status === 'TRIPPED' && !opts.backfill
      ? [
          'Writes are now off for this space. Look at the run, then turn them back on with `space:writes --on`.',
        ]
      : []),
    ...(result.error ? [`error: ${result.error}`] : []),
    `run \`${result.runId}\``,
  ];
  try {
    await deps.notify(lines.join('\n'));
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Slack alert failed',
    );
  }
}

function progressOf(
  done: number,
  total: number,
  startedAt: number,
  at: Date,
): Progress {
  const minutes = (at.getTime() - startedAt) / 60_000;
  const perMinute = minutes > 0 ? done / minutes : 0;
  return {
    done,
    total,
    perMinute: Math.round(perMinute * 10) / 10,
    etaSeconds:
      perMinute > 0 ? Math.round(((total - done) / perMinute) * 60) : null,
    updatedAt: at.toISOString(),
  };
}

/** Writes not yet attempted when a run stops are marked, so the run's rows
 *  say what happened; the next run plans them again. */
async function interrupt(
  deps: RunDeps,
  run: JobRun,
  log: Logger,
): Promise<RunStatus> {
  const { count } = await deps.prisma.plannedWrite.updateMany({
    where: { runId: run.id, status: 'PLANNED' },
    data: { status: 'SKIPPED', detail: 'run interrupted before this write' },
  });
  log.warn(
    { notAttempted: count },
    'run interrupted; the next run plans the rest again',
  );
  return 'INTERRUPTED';
}

/**
 * A run killed outright (power loss, OOM, `kill -9`) stays RUNNING with up to
 * a batch of writes sent but never read back. Holding the lock proves that
 * run is dead, so settle its writes now: read each one back and record what
 * Qomon has. Its unattempted writes are marked, and the run INTERRUPTED.
 */
async function reconcileAbandoned(
  deps: RunDeps,
  qomon: QomonApi,
  space: Space,
  run: JobRun,
  presence: PresenceConfig,
  log: Logger,
): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const abandoned = await deps.prisma.jobRun.findMany({
    where: {
      job: JOB,
      spaceKey: space.key,
      status: 'RUNNING',
      id: { not: run.id },
    },
  });
  let reconciled = 0;
  for (const old of abandoned) {
    const unsettled = await deps.prisma.plannedWrite.findMany({
      where: { runId: old.id, status: { in: ['APPLYING', 'APPLIED'] } },
    });
    for (const write of unsettled) {
      let seen;
      try {
        seen = presenceOf(
          await qomon.getContact(write.contactId),
          presence.form,
        );
      } catch (err) {
        if (!(err instanceof QomonNotFoundError)) throw err;
        seen = null;
      }
      const verified = seen?.refId === presence.household.id;
      await deps.prisma.plannedWrite.update({
        where: { id: write.id },
        data: verified
          ? {
              status: 'VERIFIED',
              detail: `verified by run ${run.id} after the run was abandoned`,
            }
          : {
              status: 'FAILED',
              detail: seen
                ? `a different Presence was recorded (checked by run ${run.id})`
                : `not in Qomon when run ${run.id} checked; planned again`,
            },
      });
      reconciled += 1;
    }
    await deps.prisma.plannedWrite.updateMany({
      where: { runId: old.id, status: 'PLANNED' },
      data: { status: 'SKIPPED', detail: 'run abandoned before this write' },
    });
    await deps.prisma.jobRun.update({
      where: { id: old.id },
      data: {
        status: 'INTERRUPTED',
        finishedAt: now(),
        error: `abandoned; settled by run ${run.id}`,
      },
    });
    log.warn(
      { abandonedRunId: old.id, settledWrites: unsettled.length },
      'settled an abandoned run',
    );
  }
  return reconciled;
}

/** Backfills take long enough that people want to know one has started and
 *  roughly when it ends. Each write costs about three requests. */
async function announceBackfill(
  deps: RunDeps,
  space: Space,
  run: JobRun,
  total: number,
  log: Logger,
): Promise<void> {
  if (run.kind !== 'BACKFILL') return;
  const minutes = Math.ceil((total * 3) / deps.env.QOMON_RPS / 60);
  try {
    await deps.notify(
      `:hourglass_flowing_sand: ${JOB} backfill on space \`${space.key}\` started: ${total} writes, about ${minutes} min. Progress: \`pnpm job status --space ${space.key}\`. Run \`${run.id}\``,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Slack alert failed',
    );
  }
}

function statsJson(stats: Partial<RunStats>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(stats)) as Prisma.InputJsonValue;
}
