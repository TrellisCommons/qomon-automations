import { QomonNotFoundError, type QomonApi } from '@trellis/qomon-client';
import { withChangeLog } from '../../changelog/write.js';
import type { Env } from '../../env.js';
import type {
  JobRun,
  Prisma,
  PrismaClient,
  RunKind,
  RunStatus,
  Space,
} from '../../generated/prisma/index.js';
import type { HeldLock } from '../../lock.js';
import type { Logger } from '../../log.js';
import { resolveWriteMode } from '../../qomon/write-mode.js';
import { getSpace, setWritesEnabled } from '../../spaces/spaces.js';
import { fetchContacts } from './fetch.js';
import { householdKeyOf, planHouseholdMatch, type PlanStats } from './plan.js';
import {
  classifyPresence,
  isMarked,
  isRemarked,
  needsRemark,
  presenceOf,
  resolvePresenceConfig,
  type OwnWrites,
  type PresenceConfig,
} from './presence.js';

export const JOB = 'household-match';
const ACTOR = 'household-match';
const BATCH_SIZE = 20;
/** PlannedWrite.field of a marker change; household values are 'presence' */
const REMARK_FIELD = 'presence_source';
const VERIFY_POLL_MS = 3_000;
/** A full run waits this long for an incremental run to let go of the lock;
 *  an incremental run never waits, since the next one is a minute away. */
const LOCK_WAIT_MS = 10 * 60_000;
const LOCK_POLL_MS = 5_000;
/** Incremental runs every minute add 1,440 runs a day; ones that succeeded
 *  without planning a write are kept this long. Longer than a shadow day,
 *  since `job shadow` counts them. */
const QUIET_RUN_RETENTION_MS = 7 * 24 * 3600e3;

export interface RunOptions {
  spaceKey: string;
  /** `--apply`: write when the environment and the space allow it */
  apply: boolean;
  /** `--backfill`: a one-off catch-up run; see the runbook */
  backfill: boolean;
  /** `--incremental`: plan over contacts changed since the space's cursor */
  incremental?: boolean;
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
  /** what was fetched: the whole space, or changed contacts and their streets */
  scope: 'full' | 'incremental';
  changed?: number;
  streets?: number;
  /** why an incremental run fetched the whole space */
  fallback?: string;
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
  if (opts.backfill && opts.incremental) {
    throw new UsageError('--backfill and --incremental cannot be combined');
  }
  if (opts.backfill && mode.applying && opts.maxWrites === undefined) {
    throw new UsageError(
      'a backfill that applies needs --max-writes; take it from a dry run first',
    );
  }

  const lock = await acquireLock(deps, `${JOB}:${space.key}`, opts);
  if (!lock) {
    if (!opts.incremental) {
      const message = `another run held the lock for ${LOCK_WAIT_MS / 60_000} minutes; this full run did not run`;
      await deps
        .notify(`:rotating_light: ${JOB} on space \`${space.key}\`: ${message}`)
        .catch(() => {});
      throw new Error(message);
    }
    log.warn('another run holds the lock; exiting');
    return { status: 'locked' };
  }

  const run = await deps.prisma.jobRun.create({
    data: {
      job: JOB,
      spaceKey: space.key,
      kind: runKindOf(opts),
      applying: mode.applying,
    },
  });
  const runLog = log.child({ runId: run.id });
  runLog.info(
    {
      applying: mode.applying,
      blockedBy: mode.blockedBy,
      backfill: opts.backfill,
      incremental: opts.incremental ?? false,
    },
    'run started',
  );
  const stats: Partial<RunStats> = {};
  try {
    if (opts.incremental) await pruneQuietRuns(deps, space, now());
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
  const presence = await loadPresenceConfig(qomon, space);

  if (applying)
    stats.reconciled = await reconcileAbandoned(
      deps,
      qomon,
      space,
      run,
      presence,
      log,
    );

  const ownWrites = await loadOwnWrites(deps.prisma, space.key);
  const fetched = await fetchContacts(qomon, {
    incremental: opts.incremental ?? false,
    cursor: space.changedCursor,
    presence,
    ownWrites,
    municipality: space.municipality,
    now: deps.now ?? (() => new Date()),
  });
  const { contacts } = fetched;
  stats.scope = fetched.scope;
  if (fetched.scope === 'incremental')
    Object.assign(stats, {
      changed: fetched.changed,
      streets: fetched.streets,
    });
  if (fetched.fallback) stats.fallback = fetched.fallback;
  if (deps.signal?.aborted) return interrupt(deps, run, log);
  const plan = planHouseholdMatch(
    contacts,
    presence,
    space.municipality,
    ownWrites,
  );
  const limit = opts.maxWrites ?? deps.env.MAX_WRITES_PER_RUN;
  const total = plan.writes.length + plan.remarks.length;
  Object.assign(stats, plan.stats, { limit, overLimit: total > limit });
  log.info(
    {
      ...plan.stats,
      limit,
      scope: fetched.scope,
      changed: fetched.changed,
      streets: fetched.streets,
      fallback: fetched.fallback,
    },
    'planned',
  );

  if (plan.writes.length > 0) {
    await deps.prisma.plannedWrite.createMany({
      data: plan.writes.map((w) => ({
        runId: run.id,
        contactId: w.contactId,
        field: 'presence',
        valueBefore: null,
        valueAfter: presence.household.value,
        triggerContactId: w.triggerContactId,
        reason: `household of contact ${w.triggerContactId} (${w.triggerValue}${w.triggerDate ? ` at ${w.triggerDate}` : ''})`,
      })),
    });
  }
  if (plan.remarks.length > 0) {
    await deps.prisma.plannedWrite.createMany({
      data: plan.remarks.map((r) => ({
        runId: run.id,
        contactId: r.contactId,
        field: REMARK_FIELD,
        valueBefore: presence.marker.value.value,
        valueAfter: presence.marker.recanvassed.value,
        triggerContactId: r.contactId,
        reason: `Presence recorded as ${r.presenceValue} after the household match`,
      })),
    });
  }

  // The cursor moves once a run has planned, whether or not its writes land:
  // a write left undone (a dry run, writes off, a failure, a trip) is the
  // next full run's, so a stuck write never holds incremental runs back.
  await deps.prisma.space.update({
    where: { key: space.key },
    data: { changedCursor: fetched.searchedAt },
  });

  if (!applying || total === 0) return 'SUCCEEDED';
  if (deps.signal?.aborted) return interrupt(deps, run, log);

  if (total > limit) {
    if (opts.backfill) {
      log.warn(
        { planned: total, limit },
        'plan exceeds --max-writes; nothing written',
      );
    } else {
      await trip(
        deps,
        space,
        `run ${run.id} planned ${total} writes, over the limit of ${limit}`,
        log,
      );
    }
    return 'TRIPPED';
  }

  const keys = new Map(contacts.map((c) => [c.id, householdKeyOf(c)]));
  return applyAndVerify(
    deps,
    qomon,
    space,
    run,
    presence,
    keys,
    ownWrites,
    stats,
    log,
  );
}

async function applyAndVerify(
  deps: RunDeps,
  qomon: QomonApi,
  space: Space,
  run: JobRun,
  presence: PresenceConfig,
  keys: Map<number | undefined, string | null>,
  ownWrites: OwnWrites,
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
      const remark = write.field === REMARK_FIELD;
      const skip = remark
        ? needsRemark(
            current,
            classifyPresence(current, presence, ownWrites).kind,
            presence,
          )
          ? null
          : 'no longer needs re-marking'
        : presenceOf(current, presence.form)
          ? 'has a Presence since the fetch'
          : householdKeyOf(current) !== keys.get(write.contactId)
            ? 'address changed since the fetch'
            : null;
      if (skip) {
        await mark(write.id, 'SKIPPED', skip);
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
            ...(remark
              ? {
                  before: { presenceSource: write.valueBefore },
                  after: { presenceSource: write.valueAfter },
                }
              : {
                  before: { presence: null },
                  after: {
                    presence: write.valueAfter,
                    triggerContactId: write.triggerContactId,
                  },
                }),
          });
        },
      );
      attempted += 1;
      try {
        // a re-mark touches only the custom field; Presence is left as the
        // person recorded it
        await qomon.upsertContact(
          remark
            ? {
                id: write.contactId,
                custom_fields: [
                  {
                    id: presence.marker.form.id,
                    value: presence.marker.recanvassed.value,
                  },
                ],
              }
            : {
                id: write.contactId,
                name_presences: [
                  { id: presence.form.id, value: presence.household.value },
                ],
                // Qomon applies a record whole or drops it whole (test space,
                // 2026-10-11): the value never lands without its marker
                custom_fields: [
                  {
                    id: presence.marker.form.id,
                    value: presence.marker.value.value,
                  },
                ],
              },
        );
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
        const seen = await readBack(qomon, write, presence);
        if (seen.state === 'pending') continue;
        pending.delete(write.id);
        if (seen.state === 'verified') {
          await deps.prisma.plannedWrite.update({
            where: { id: write.id },
            data: {
              status: 'VERIFIED',
              detail: null,
              writtenPresenceDate: seen.date,
            },
          });
          counts.verified += 1;
        } else {
          await mark(write.id, 'FAILED', READ_BACK_FAILURES[seen.state]);
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

/** Slack hears about a run only when something went wrong: a write failed,
 *  or the run failed or tripped. Successful runs, and runs stopped on
 *  purpose, send nothing; the health check catches a run that stops
 *  reporting altogether. A failed run is not posted when the previous run of
 *  the same kind failed with the same error, so an outage under a run every
 *  minute posts once. */
async function report(
  deps: RunDeps,
  space: Space,
  result: RunResult,
  opts: RunOptions,
  log: Logger,
): Promise<void> {
  if (!('runId' in result)) return;
  const s = result.stats;
  const failed =
    (s.failed ?? 0) > 0 ||
    result.status === 'FAILED' ||
    result.status === 'TRIPPED';
  if (!failed) return;
  if (
    result.status === 'FAILED' &&
    (await repeatsPreviousFailure(deps, space, opts, result))
  )
    return;
  const lines = [
    `:rotating_light: ${JOB}${opts.backfill ? ' (backfill)' : ''} on space \`${space.key}\`: ${result.status}`,
    `planned ${s.planned ?? 0} · applied ${s.applied ?? 0} · verified ${s.verified ?? 0} · failed ${s.failed ?? 0} · skipped ${s.skipped ?? 0} · unkeyable ${s.unkeyable ?? 0}`,
    ...(result.status === 'TRIPPED' && !opts.backfill
      ? [
          'Writes are now off for this space. Look at the run, then turn them back on with `space:writes --on`.',
        ]
      : []),
    ...(result.error ? [`error: ${result.error}`] : []),
    ...(result.status === 'FAILED'
      ? [
          'Runs of this kind that fail the same way are not posted until one gets through.',
        ]
      : []),
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
      const seen = await readBack(qomon, write, presence);
      await deps.prisma.plannedWrite.update({
        where: { id: write.id },
        data:
          seen.state === 'verified'
            ? {
                status: 'VERIFIED',
                detail: `verified by run ${run.id} after the run was abandoned`,
                writtenPresenceDate: seen.date,
              }
            : {
                status: 'FAILED',
                detail:
                  seen.state === 'pending'
                    ? `not in Qomon when run ${run.id} checked; planned again`
                    : `${READ_BACK_FAILURES[seen.state]} (checked by run ${run.id})`,
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

async function repeatsPreviousFailure(
  deps: RunDeps,
  space: Space,
  opts: RunOptions,
  result: { runId: string; error?: string },
): Promise<boolean> {
  const previous = await deps.prisma.jobRun.findFirst({
    where: {
      job: JOB,
      spaceKey: space.key,
      kind: runKindOf(opts),
      id: { not: result.runId },
    },
    orderBy: { startedAt: 'desc' },
    select: { status: true, error: true },
  });
  return (
    previous?.status === 'FAILED' && previous.error === (result.error ?? null)
  );
}

async function pruneQuietRuns(deps: RunDeps, space: Space, now: Date) {
  await deps.prisma.jobRun.deleteMany({
    where: {
      job: JOB,
      spaceKey: space.key,
      kind: 'INCREMENTAL',
      status: 'SUCCEEDED',
      startedAt: { lt: new Date(now.getTime() - QUIET_RUN_RETENTION_MS) },
      writes: { none: {} },
    },
  });
}

function runKindOf(opts: RunOptions): RunKind {
  return opts.backfill
    ? 'BACKFILL'
    : opts.incremental
      ? 'INCREMENTAL'
      : 'HOURLY';
}

async function acquireLock(
  deps: RunDeps,
  name: string,
  opts: RunOptions,
): Promise<HeldLock | null> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; ; waited += LOCK_POLL_MS) {
    const lock = await deps.lock(name);
    if (lock || opts.incremental || waited >= LOCK_WAIT_MS) return lock;
    if (waited === 0) deps.log.info('another run holds the lock; waiting');
    await sleep(LOCK_POLL_MS);
  }
}

function statsJson(stats: Partial<RunStats>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(stats)) as Prisma.InputJsonValue;
}

export async function loadPresenceConfig(
  qomon: QomonApi,
  space: Space,
): Promise<PresenceConfig> {
  return resolvePresenceConfig(
    await qomon.listFormsByType('presence_status'),
    await qomon.listFormsByType('custom_fields'),
    space,
  );
}

/** Contacts this job wrote and verified in the space, with the Presence date
 *  each write got (see `classifyPresence`). */
async function loadOwnWrites(
  prisma: PrismaClient,
  spaceKey: string,
): Promise<OwnWrites> {
  const rows = await prisma.plannedWrite.findMany({
    where: { status: 'VERIFIED', field: 'presence', run: { spaceKey } },
    select: { contactId: true, writtenPresenceDate: true },
    orderBy: { updatedAt: 'asc' },
  });
  return new Map(rows.map((r) => [r.contactId, r.writtenPresenceDate]));
}

type ReadBack =
  | { state: 'verified'; date: string | null }
  | {
      state: 'pending' | 'different' | 'unmarked' | 'markerChanged' | 'deleted';
    };

const READ_BACK_FAILURES = {
  different: 'a different Presence was recorded',
  unmarked: 'the household value is there without its marker',
  markerChanged: 'the marker was changed or removed by someone else',
  deleted: 'contact deleted before it could be verified',
} as const;

/** A write is verified when Qomon shows the household value with its
 *  marker; `pending` means no Presence yet. */
async function readBack(
  qomon: QomonApi,
  write: { contactId: number; field: string },
  presence: PresenceConfig,
): Promise<ReadBack> {
  let contact;
  try {
    contact = await qomon.getContact(write.contactId);
  } catch (err) {
    if (err instanceof QomonNotFoundError) return { state: 'deleted' };
    throw err;
  }
  if (write.field === REMARK_FIELD) {
    if (isRemarked(contact, presence)) return { state: 'verified', date: null };
    return isMarked(contact, presence)
      ? { state: 'pending' }
      : { state: 'markerChanged' };
  }
  const seen = presenceOf(contact, presence.form);
  if (!seen) return { state: 'pending' };
  if (seen.refId !== presence.household.id) return { state: 'different' };
  if (!isMarked(contact, presence)) return { state: 'unmarked' };
  return { state: 'verified', date: seen.date };
}
