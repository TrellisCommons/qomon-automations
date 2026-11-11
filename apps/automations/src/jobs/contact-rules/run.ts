import {
  QomonNotFoundError,
  collectContacts,
  type QomonApi,
  type QomonContact,
  type QomonContactUpsert,
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
import {
  deceasedStateOf,
  isBlacklisted,
  planDeceased,
  resolveDeceasedConfig,
  type DeceasedConfig,
  type DeceasedPlanStats,
  type Handled,
} from './deceased.js';
import {
  householdKeyOf,
  planHouseholdMatch,
  type PlanStats,
} from './household.js';
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

export const JOB = 'contact-rules';
/** contact ids listed in one Slack message */
const REVIEW_SHOWN = 20;
const ACTOR = 'contact-rules';
/** contacts per batch; each gets one upsert carrying all of its changes */
const BATCH_SIZE = 20;
const VERIFY_POLL_MS = 3_000;

/** PlannedWrite.field of each kind of change */
const PRESENCE_FIELD = 'presence';
const REMARK_FIELD = 'presence_source';
const BLACKLIST_FIELD = 'black_list';

export interface RuleConfig {
  presence: PresenceConfig;
  /** null when the space has the deceased rule off */
  deceased: DeceasedConfig | null;
}

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

export interface RunStats extends PlanStats, Partial<DeceasedPlanStats> {
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
      /** contacts the deceased rule blacklisted that are no longer marked
       *  deceased but still blacklisted, for a person to decide on */
      review: number[];
      error?: string;
    };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export async function runContactRules(
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
  const review: number[] = [];
  try {
    const status = await execute(
      deps,
      opts,
      space,
      run,
      mode.applying,
      stats,
      review,
      runLog,
    );
    const result = await finish(deps, run, status, stats, review);
    await report(deps, space, result, opts, runLog);
    return result;
  } catch (err) {
    const error =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    runLog.error({ err: error }, 'run failed');
    const result = await finish(deps, run, 'FAILED', stats, review, error);
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
  review: number[],
  log: Logger,
): Promise<RunStatus> {
  const qomon = deps.qomonFor(space);
  const config = await loadRuleConfig(qomon, space);
  const { presence } = config;

  if (applying)
    stats.reconciled = await reconcileAbandoned(
      deps,
      qomon,
      space,
      run,
      config,
      log,
    );

  const contacts = await collectContacts(qomon, { $all: [] });
  if (deps.signal?.aborted) return interrupt(deps, run, log);
  const ownWrites = await loadOwnWrites(deps.prisma, space.key);
  const plan = planHouseholdMatch(
    contacts,
    presence,
    space.municipality,
    ownWrites,
  );
  const deceased = config.deceased
    ? planDeceased(
        contacts,
        config.deceased,
        await loadHandled(deps.prisma, space.key),
      )
    : null;
  const limit = opts.maxWrites ?? deps.env.MAX_WRITES_PER_RUN;
  const total =
    plan.writes.length + plan.remarks.length + (deceased?.writes.length ?? 0);
  Object.assign(stats, plan.stats, deceased?.stats, {
    limit,
    overLimit: total > limit,
  });
  log.info({ ...plan.stats, ...deceased?.stats, limit }, 'planned');

  if (deceased) {
    // What the job knows about deceased contacts is kept current on every
    // run, dry runs included: it records what Qomon shows, not a write.
    await recordHandled(deps.prisma, space.key, run.id, deceased);
    review.push(...deceased.review);
  }

  if (plan.writes.length > 0) {
    await deps.prisma.plannedWrite.createMany({
      data: plan.writes.map((w) => ({
        runId: run.id,
        contactId: w.contactId,
        field: PRESENCE_FIELD,
        valueBefore: null,
        valueAfter: presence.household.value,
        triggerContactId: w.triggerContactId,
        reason: `household of contact ${w.triggerContactId} (${w.triggerValue}${w.triggerDate ? ` on ${w.triggerDate.slice(0, 10)}` : ''})`,
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
  if (deceased && deceased.writes.length > 0) {
    await deps.prisma.plannedWrite.createMany({
      data: deceased.writes.map((contactId) => ({
        runId: run.id,
        contactId,
        field: BLACKLIST_FIELD,
        valueBefore: 'false',
        valueAfter: 'true',
        triggerContactId: contactId,
        reason: `marked deceased (${config.deceased!.field.label})`,
      })),
    });
  }

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
    config,
    keys,
    ownWrites,
    stats,
    log,
  );
}

type Write = Awaited<
  ReturnType<PrismaClient['plannedWrite']['findMany']>
>[number];

async function applyAndVerify(
  deps: RunDeps,
  qomon: QomonApi,
  space: Space,
  run: JobRun,
  config: RuleConfig,
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
    orderBy: [{ contactId: 'asc' }, { field: 'asc' }],
  });
  const byContact = new Map<number, Write[]>();
  for (const write of writes) {
    const rows = byContact.get(write.contactId);
    if (rows) rows.push(write);
    else byContact.set(write.contactId, [write]);
  }
  const groups = [...byContact.values()];
  const mark = (
    ids: string[],
    status: 'SKIPPED' | 'APPLIED' | 'FAILED',
    detail?: string,
  ) =>
    deps.prisma.plannedWrite.updateMany({
      where: { id: { in: ids } },
      data: { status, detail: detail ?? null },
    });

  const startedAt = now().getTime();
  if (stats.reconciled === undefined) stats.reconciled = 0;
  let done = 0;
  for (let i = 0; i < groups.length; i += BATCH_SIZE) {
    const sent: Write[] = [];
    for (const group of groups.slice(i, i + BATCH_SIZE)) {
      if (deps.signal?.aborted) break;
      done += group.length;
      const contactId = group[0]!.contactId;
      // Presence is one value that an upsert replaces: re-read right before
      // writing so a visit recorded since the fetch is not overwritten.
      let current;
      try {
        current = await qomon.getContact(contactId);
      } catch (err) {
        if (!(err instanceof QomonNotFoundError)) throw err;
        await mark(
          group.map((w) => w.id),
          'SKIPPED',
          'contact no longer exists',
        );
        counts.skipped += group.length;
        continue;
      }
      const ready: Write[] = [];
      for (const write of group) {
        const skip = stillNeeded(write, current, config, keys, ownWrites);
        if (skip) {
          await mark([write.id], 'SKIPPED', skip);
          counts.skipped += 1;
        } else ready.push(write);
      }
      if (ready.length === 0) continue;

      await withChangeLog(
        deps.prisma,
        {
          actor: ACTOR,
          reason: ready.map((w) => w.reason).join('; '),
          correlationId: run.id,
        },
        async (ctx) => {
          await ctx.tx.plannedWrite.updateMany({
            where: { id: { in: ready.map((w) => w.id) } },
            data: { status: 'APPLYING' },
          });
          for (const write of ready) {
            await ctx.log({
              subjectType: 'QomonContact',
              subjectId: String(contactId),
              ...changeOf(write),
            });
          }
        },
      );
      attempted += ready.length;
      try {
        // One upsert per contact: Qomon applies a record whole or drops it
        // whole (test space, 2026-10-11), and two upserts to one contact in
        // quick succession can leave duplicate answers (demo space,
        // 2026-11-11).
        await qomon.upsertContact(
          mergeUpserts(
            contactId,
            ready.map((w) => upsertOf(w, config)),
          ),
        );
        await mark(
          ready.map((w) => w.id),
          'APPLIED',
        );
        counts.applied += ready.length;
        sent.push(...ready);
      } catch (err) {
        await mark(
          ready.map((w) => w.id),
          'FAILED',
          err instanceof Error ? err.message : String(err),
        );
        counts.failed += ready.length;
      }
    }

    // Upsert answers 202 and drops bad records silently: a write counts only
    // once it is read back.
    const pending = new Map(sent.map((w) => [w.id, w]));
    const deadline = now().getTime() + deps.env.VERIFY_TIMEOUT_SECONDS * 1000;
    while (pending.size > 0) {
      const contactIds = [
        ...new Set([...pending.values()].map((w) => w.contactId)),
      ];
      for (const contactId of contactIds) {
        const contact = await readContact(qomon, contactId);
        for (const write of [...pending.values()].filter(
          (w) => w.contactId === contactId,
        )) {
          const seen = readBack(contact, write, config);
          if (seen.state === 'pending') continue;
          pending.delete(write.id);
          if (seen.state === 'verified') {
            await settleVerified(deps.prisma, space.key, run.id, write, seen);
            counts.verified += 1;
          } else {
            await mark([write.id], 'FAILED', READ_BACK_FAILURES[seen.state]);
            counts.failed += 1;
          }
        }
      }
      if (pending.size === 0) break;
      if (now().getTime() >= deadline) {
        await mark(
          [...pending.keys()],
          'FAILED',
          `not visible after ${deps.env.VERIFY_TIMEOUT_SECONDS}s`,
        );
        counts.failed += pending.size;
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

/** Why a planned write is no longer wanted, judged on the contact as re-read
 *  just before writing; null when it still is. */
function stillNeeded(
  write: Write,
  current: QomonContact,
  config: RuleConfig,
  keys: Map<number | undefined, string | null>,
  ownWrites: OwnWrites,
): string | null {
  const { presence } = config;
  switch (write.field) {
    case REMARK_FIELD:
      return needsRemark(
        current,
        classifyPresence(current, presence, ownWrites).kind,
        presence,
      )
        ? null
        : 'no longer needs re-marking';
    case BLACKLIST_FIELD:
      if (!config.deceased) return 'the deceased rule is off';
      if (deceasedStateOf(current, config.deceased) !== 'deceased')
        return 'no longer marked deceased';
      return isBlacklisted(current) ? 'already "Do not contact"' : null;
    default:
      if (presenceOf(current, presence.form))
        return 'has a Presence since the fetch';
      return householdKeyOf(current) !== keys.get(write.contactId)
        ? 'address changed since the fetch'
        : null;
  }
}

function changeOf(write: Write): {
  before: Prisma.InputJsonValue;
  after: Prisma.InputJsonValue;
} {
  switch (write.field) {
    case REMARK_FIELD:
      return {
        before: { presenceSource: write.valueBefore },
        after: { presenceSource: write.valueAfter },
      };
    case BLACKLIST_FIELD:
      return { before: { blackList: false }, after: { blackList: true } };
    default:
      return {
        before: { presence: null },
        after: {
          presence: write.valueAfter,
          triggerContactId: write.triggerContactId,
        },
      };
  }
}

/** The part of a contact's upsert one write contributes. A re-mark touches
 *  only the custom field; Presence stays as the person recorded it. */
function upsertOf(
  write: Write,
  config: RuleConfig,
): Omit<QomonContactUpsert, 'id'> {
  const { presence } = config;
  switch (write.field) {
    case REMARK_FIELD:
      return {
        custom_fields: [
          {
            id: presence.marker.form.id,
            value: presence.marker.recanvassed.value,
          },
        ],
      };
    case BLACKLIST_FIELD:
      return { black_list: true };
    default:
      return {
        name_presences: [
          { id: presence.form.id, value: presence.household.value },
        ],
        // in the same record, so the value never lands without its marker
        custom_fields: [
          { id: presence.marker.form.id, value: presence.marker.value.value },
        ],
      };
  }
}

export function mergeUpserts(
  id: number,
  parts: Omit<QomonContactUpsert, 'id'>[],
): QomonContactUpsert {
  const merged: QomonContactUpsert = { id };
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      const existing = merged[key];
      merged[key] =
        Array.isArray(existing) && Array.isArray(value)
          ? [...existing, ...value]
          : value;
    }
  }
  return merged;
}

/** Record a verified write. A "Do not contact" write also marks the contact
 *  handled, so the rule leaves it alone from now on. */
async function settleVerified(
  prisma: PrismaClient,
  spaceKey: string,
  runId: string,
  write: Write,
  seen: { date: string | null },
  detail: string | null = null,
): Promise<void> {
  await prisma.plannedWrite.update({
    where: { id: write.id },
    data: { status: 'VERIFIED', detail, writtenPresenceDate: seen.date },
  });
  if (write.field === BLACKLIST_FIELD) {
    await prisma.handledDeceased.upsert({
      where: { spaceKey_contactId: { spaceKey, contactId: write.contactId } },
      create: {
        spaceKey,
        contactId: write.contactId,
        handling: 'WRITTEN',
        runId,
      },
      update: { handling: 'WRITTEN', runId, at: new Date() },
    });
  }
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
  review: number[],
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
  return {
    status,
    runId: run.id,
    applying: run.applying,
    stats,
    review,
    error,
  };
}

/** Slack hears about a run only when something went wrong (a write failed,
 *  or the run failed or tripped) or a person must decide something (a
 *  contact the job blacklisted is no longer marked deceased). Other runs,
 *  and runs stopped on purpose, send nothing; the health check catches a
 *  run that stops reporting altogether. */
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
  if (!failed && result.review.length === 0) return;
  const lines = failed
    ? [
        `:rotating_light: ${JOB}${opts.backfill ? ' (backfill)' : ''} on space \`${space.key}\`: ${result.status}`,
        `planned ${s.planned ?? 0} household · ${s.remarks ?? 0} re-marks · ${s.deceasedPlanned ?? 0} do not contact · applied ${s.applied ?? 0} · verified ${s.verified ?? 0} · failed ${s.failed ?? 0} · skipped ${s.skipped ?? 0} · unkeyable ${s.unkeyable ?? 0}`,
        ...(result.status === 'TRIPPED' && !opts.backfill
          ? [
              'Writes are now off for this space. Look at the run, then turn them back on with `space:writes --on`.',
            ]
          : []),
        ...(result.error ? [`error: ${result.error}`] : []),
      ]
    : [];
  if (result.review.length > 0) {
    const shown = result.review.slice(0, REVIEW_SHOWN);
    lines.push(
      `:eyes: ${result.review.length} contact${result.review.length === 1 ? ' is' : 's are'} no longer marked deceased but still "Do not contact", which this job turned on. Decide whether to turn it off: ${shown.join(', ')}${result.review.length > shown.length ? ` and ${result.review.length - shown.length} more` : ''}`,
    );
  }
  lines.push(`space \`${space.key}\` · run \`${result.runId}\``);
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
  config: RuleConfig,
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
      const seen = readBack(
        await readContact(qomon, write.contactId),
        write,
        config,
      );
      if (seen.state === 'verified') {
        await settleVerified(
          deps.prisma,
          space.key,
          old.id,
          write,
          seen,
          `verified by run ${run.id} after the run was abandoned`,
        );
      } else {
        await deps.prisma.plannedWrite.update({
          where: { id: write.id },
          data: {
            status: 'FAILED',
            detail:
              seen.state === 'pending'
                ? `not in Qomon when run ${run.id} checked; planned again`
                : `${READ_BACK_FAILURES[seen.state]} (checked by run ${run.id})`,
          },
        });
      }
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

function statsJson(stats: Partial<RunStats>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(stats)) as Prisma.InputJsonValue;
}

/** The space's settings checked against its forms; a mismatch stops the
 *  run before it plans anything. */
export async function loadRuleConfig(
  qomon: QomonApi,
  space: Space,
): Promise<RuleConfig> {
  const customFields = await qomon.listFormsByType('custom_fields');
  return {
    presence: resolvePresenceConfig(
      await qomon.listFormsByType('presence_status'),
      customFields,
      space,
    ),
    deceased: resolveDeceasedConfig(customFields, space),
  };
}

async function loadHandled(
  prisma: PrismaClient,
  spaceKey: string,
): Promise<Handled> {
  const rows = await prisma.handledDeceased.findMany({ where: { spaceKey } });
  return new Map(rows.map((r) => [r.contactId, r.handling]));
}

/** Contacts found already blacklisted become handled; contacts no longer
 *  marked are forgotten, so marking them again acts again. */
async function recordHandled(
  prisma: PrismaClient,
  spaceKey: string,
  runId: string,
  plan: { found: number[]; rearm: number[] },
): Promise<void> {
  if (plan.found.length > 0) {
    await prisma.handledDeceased.createMany({
      data: plan.found.map((contactId) => ({
        spaceKey,
        contactId,
        handling: 'FOUND' as const,
        runId,
      })),
      skipDuplicates: true,
    });
  }
  if (plan.rearm.length > 0) {
    await prisma.handledDeceased.deleteMany({
      where: { spaceKey, contactId: { in: plan.rearm } },
    });
  }
}

/** Contacts this job wrote and verified in the space, with the Presence date
 *  each write got (see `classifyPresence`). */
async function loadOwnWrites(
  prisma: PrismaClient,
  spaceKey: string,
): Promise<OwnWrites> {
  const rows = await prisma.plannedWrite.findMany({
    where: { status: 'VERIFIED', field: PRESENCE_FIELD, run: { spaceKey } },
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

async function readContact(
  qomon: QomonApi,
  contactId: number,
): Promise<QomonContact | null> {
  try {
    return await qomon.getContact(contactId);
  } catch (err) {
    if (err instanceof QomonNotFoundError) return null;
    throw err;
  }
}

/** Whether Qomon shows a write yet; `pending` means not yet. A household
 *  value counts only with its marker. */
function readBack(
  contact: QomonContact | null,
  write: { field: string },
  config: RuleConfig,
): ReadBack {
  if (!contact) return { state: 'deleted' };
  const { presence } = config;
  switch (write.field) {
    case REMARK_FIELD:
      if (isRemarked(contact, presence))
        return { state: 'verified', date: null };
      return isMarked(contact, presence)
        ? { state: 'pending' }
        : { state: 'markerChanged' };
    case BLACKLIST_FIELD:
      return isBlacklisted(contact)
        ? { state: 'verified', date: null }
        : { state: 'pending' };
    default: {
      const seen = presenceOf(contact, presence.form);
      if (!seen) return { state: 'pending' };
      if (seen.refId !== presence.household.id) return { state: 'different' };
      if (!isMarked(contact, presence)) return { state: 'unmarked' };
      return { state: 'verified', date: seen.date };
    }
  }
}
