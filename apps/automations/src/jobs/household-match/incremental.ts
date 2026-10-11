import { createHash } from 'node:crypto';
import {
  paginateContacts,
  QomonMalformedResponseError,
  QomonNotFoundError,
  type QomonApi,
  type QomonContact,
} from '@trellis/qomon-client';
import { condition, event, syncAlerts, type Alert } from '../../alerts.js';
import type {
  JobRun,
  PrismaClient,
  RunStatus,
  Space,
} from '../../generated/prisma/index.js';
import type { Logger } from '../../log.js';
import {
  contactOf,
  householdHashOf,
  keyIdOf,
  mirrorRowOf,
  relevantChange,
  type MirrorRow,
} from './mirror.js';
import {
  planHousehold,
  remarkFor,
  type PlannedHouseholdWrite,
  type PlannedRemark,
} from './plan.js';
import type { OwnWrites, PresenceConfig } from './presence.js';
import type { RunDeps, RunOptions, RunResult, RunStats } from './run.js';

/**
 * The incremental household match (docs/household-match/incremental-design.md).
 *
 * **Ingest** reads the contacts changed since the cursor (or every contact,
 * on a sweep), updates the mirror, and marks the old and new household of
 * each relevant change dirty. The cursor moves last, so it never runs ahead
 * of the mirror; a run that dies re-reads the same window next time.
 *
 * **Work** plans each due dirty household from the mirror with the same
 * rules as the full job and applies through the same write path. A household
 * leaves the dirty table only once its writes have settled; failures back
 * off, then quarantine, so one bad household never holds up the rest.
 */

const PAGE = 1000;
/** A minutely job writes 1,440 runs a day; ones that did nothing are kept
 *  only this long. Runs with writes, and failed runs, are kept. */
const QUIET_RUN_RETENTION_MS = 7 * 24 * 3600e3;

export interface IncrementalStats {
  sweep: boolean;
  /** contacts read from Qomon this run */
  changed: number;
  /** of those, the ones whose change matters to the rules */
  relevant: number;
  /** contacts gone from Qomon (sweeps only) */
  deleted: number;
  /** contacts in the mirror a sweep's listing did not return */
  missing: number;
  /** too many were missing to trust the listing, so none were deleted */
  deleteRefused: boolean;
  /** contacts a sweep found changed that the minutely ingest should have
   *  seen: the measure of whether UpdatedAt can be trusted */
  drift: number;
  invalidContacts: number;
  dirtyHouseholds: number;
  quarantined: number;
}

export interface WritePath {
  persistPlan(
    writes: PlannedHouseholdWrite[],
    remarks: PlannedRemark[],
  ): Promise<void>;
  apply(
    addressUnchanged: (current: QomonContact, contactId: number) => boolean,
  ): Promise<RunStatus>;
  trip(reason: string): Promise<void>;
  interrupt(): Promise<RunStatus>;
  ownWrites(): Promise<OwnWrites>;
}

export interface IncrementalContext {
  deps: RunDeps;
  opts: RunOptions;
  space: Space;
  run: JobRun;
  applying: boolean;
  qomon: QomonApi;
  presence: PresenceConfig;
  secret: Buffer;
  stats: Partial<RunStats & IncrementalStats>;
  log: Logger;
  write: WritePath;
}

export async function executeIncremental(
  ctx: IncrementalContext,
): Promise<RunStatus> {
  const { deps, opts, space, run, applying, presence, stats, log, write } = ctx;
  const now = deps.now ?? (() => new Date());

  await ingest(ctx);
  if (deps.signal?.aborted) return write.interrupt();
  await deps.prisma.jobRun.deleteMany({
    where: {
      spaceKey: space.key,
      kind: { in: ['INCREMENTAL', 'SWEEP'] },
      status: 'SUCCEEDED',
      startedAt: { lt: new Date(now().getTime() - QUIET_RUN_RETENTION_MS) },
      writes: { none: {} },
    },
  });

  // Work: the longest-due dirty households, planned from the mirror. A burst
  // drains over several runs.
  const dueWhere = {
    spaceKey: space.key,
    quarantinedAt: null,
    nextAttemptAt: { lte: now() },
  };
  const due = await deps.prisma.dirtyHousehold.findMany({
    where: dueWhere,
    orderBy: [{ nextAttemptAt: 'asc' }, { markedAt: 'asc' }],
    take: deps.env.INCREMENTAL_MAX_HOUSEHOLDS_PER_RUN,
    select: { householdHash: true },
  });
  const hashes = due.map((d) => d.householdHash);
  stats.dirtyHouseholds = await deps.prisma.dirtyHousehold.count({
    where: dueWhere,
  });
  const members = await membersOf(deps.prisma, space.key, hashes);
  const ownWrites = await write.ownWrites();

  const writes: PlannedHouseholdWrite[] = [];
  const remarks: PlannedRemark[] = [];
  const hashOf = new Map<number, string>();
  let canvassed = 0;
  for (const [hash, rows] of members) {
    const contacts = rows.map((r) => contactOf(r, presence));
    for (const r of rows) hashOf.set(r.contactId, hash);
    const plan = planHousehold(contacts, presence, ownWrites);
    if (plan.canvassed) canvassed += 1;
    writes.push(...plan.writes);
    for (const c of contacts) {
      const remark = remarkFor(c, presence, ownWrites);
      if (remark) remarks.push(remark);
    }
  }
  writes.sort((a, b) => a.contactId - b.contactId);
  remarks.sort((a, b) => a.contactId - b.contactId);
  const limit = opts.maxWrites ?? deps.env.INCREMENTAL_MAX_WRITES_PER_RUN;
  const total = writes.length + remarks.length;
  Object.assign(stats, {
    households: members.size,
    canvassedHouseholds: canvassed,
    planned: writes.length,
    remarks: remarks.length,
    limit,
    overLimit: total > limit,
  });
  log.info({ ...stats }, 'planned');
  await write.persistPlan(writes, remarks);

  if (!applying) {
    await defer(ctx, hashes, hashOf, [...writes, ...remarks]);
    return 'SUCCEEDED';
  }
  if (total > limit) {
    if (opts.backfill) {
      log.warn(
        { planned: total, limit },
        'plan exceeds --max-writes; nothing written',
      );
    } else {
      await write.trip(
        `run ${run.id} planned ${total} writes, over the sanity limit of ${limit}`,
      );
    }
    return 'TRIPPED';
  }

  const status =
    total === 0
      ? 'SUCCEEDED'
      : await write.apply(
          (current, id) =>
            householdHashOf(current, space.key, ctx.secret) === hashOf.get(id),
        );
  await settle(ctx, hashes, hashOf);
  return status;
}

/** Changes since the cursor, or every contact on a sweep, into the mirror. */
async function ingest(ctx: IncrementalContext): Promise<void> {
  const { deps, space, presence, secret, stats, log } = ctx;
  const prisma = deps.prisma;
  const now = deps.now ?? (() => new Date());
  const overlapMs = deps.env.INCREMENTAL_OVERLAP_SECONDS * 1000;
  const startedAt = now();

  const cursorRow = await prisma.syncCursor.findUnique({
    where: { spaceKey_job: { spaceKey: space.key, job: 'household-match' } },
  });
  const previous = cursorRow?.cursor ?? null;
  // Hashes made with another key never match new ones: rehash everything at
  // once rather than split households until the next sweep.
  const keyId = keyIdOf(secret);
  const rekey = cursorRow !== null && cursorRow.keyId !== keyId;
  if (rekey) log.warn('household hash key changed; sweeping to rehash');
  const sweep = ctx.opts.mode === 'sweep' || previous === null || rekey;
  const since =
    previous === null ? null : new Date(Date.parse(previous) - overlapMs);
  Object.assign(stats, {
    sweep,
    changed: 0,
    relevant: 0,
    deleted: 0,
    missing: 0,
    deleteRefused: false,
    drift: 0,
    invalidContacts: 0,
  });

  const query = sweep
    ? { $all: [] }
    : {
        $all: [
          {
            $all: [
              {
                $condition: {
                  attr: 'UpdatedAt',
                  ope: 'gte',
                  value: since!.toISOString(),
                },
              },
            ],
          },
        ],
      };
  const seen = sweep ? new Set<number>() : null;
  let latest = previous;
  let page: QomonContact[] = [];

  const flush = async () => {
    const rows = page
      .filter((c) => c.id !== undefined)
      .map((c) =>
        mirrorRowOf(c, presence, space.municipality, space.key, secret),
      );
    page = [];
    if (rows.length === 0) return;
    const existing = new Map(
      (
        await prisma.contactMirror.findMany({
          where: {
            spaceKey: space.key,
            contactId: { in: rows.map((r) => r.contactId) },
          },
        })
      ).map((r) => [r.contactId, r as MirrorRow]),
    );
    const changedRows: MirrorRow[] = [];
    const dirty = new Set<string>();
    for (const row of rows) {
      seen?.add(row.contactId);
      if (!latest || Date.parse(row.updatedAt) > Date.parse(latest))
        latest = row.updatedAt;
      const before = existing.get(row.contactId);
      if (
        before &&
        before.updatedAt === row.updatedAt &&
        !relevantChange(before, row)
      )
        continue;
      changedRows.push(row);
      if (before && !relevantChange(before, row)) continue;
      stats.relevant! += 1;
      dirty.add(row.householdHash);
      if (before) dirty.add(before.householdHash);
      // A sweep finding a relevant change older than the last ingest window
      // means the minutely ingest missed it.
      if (
        sweep &&
        !rekey &&
        previous &&
        Date.parse(row.updatedAt) < Date.parse(previous) - overlapMs
      ) {
        stats.drift! += 1;
      }
    }
    await upsertMirror(prisma, space.key, changedRows);
    await markDirty(prisma, space.key, [...dirty]);
  };

  for await (const contact of paginateContacts(ctx.qomon, query, {
    onInvalid: (invalid) => {
      stats.invalidContacts! += 1;
      log.warn(
        { contactId: invalid.id, error: invalid.error },
        'contact failed validation; set aside',
      );
    },
  })) {
    stats.changed! += 1;
    page.push(contact);
    if (page.length >= PAGE) await flush();
    if (ctx.deps.signal?.aborted) return;
  }
  await flush();

  if (seen) {
    // Deleted contacts vanish without notice; only a sweep sees them. Paging
    // uses live offsets, so a contact edited or deleted mid-sweep can push
    // another past a page boundary: each missing contact is read directly,
    // and a listing missing too many is not trusted at all.
    const all = await prisma.contactMirror.findMany({
      where: { spaceKey: space.key },
      select: { contactId: true, householdHash: true },
    });
    const missing = all.filter((r) => !seen.has(r.contactId));
    stats.missing = missing.length;
    const gone: typeof missing = [];
    if (missing.length > deps.env.SWEEP_MAX_DELETES) {
      stats.deleteRefused = true;
      log.warn(
        { missing: missing.length, limit: deps.env.SWEEP_MAX_DELETES },
        'sweep listing is missing too many contacts; deleting none',
      );
    } else {
      for (const r of missing) {
        try {
          page.push(await ctx.qomon.getContact(r.contactId));
        } catch (err) {
          if (err instanceof QomonNotFoundError) gone.push(r);
          else if (!(err instanceof QomonMalformedResponseError)) throw err;
        }
        if (deps.signal?.aborted) return;
      }
      await flush();
    }
    for (let i = 0; i < gone.length; i += PAGE) {
      const chunk = gone.slice(i, i + PAGE);
      await markDirty(prisma, space.key, [
        ...new Set(chunk.map((r) => r.householdHash)),
      ]);
      await prisma.contactMirror.deleteMany({
        where: {
          spaceKey: space.key,
          contactId: { in: chunk.map((r) => r.contactId) },
        },
      });
    }
    stats.deleted = gone.length;
  }

  // Moves last: after a sweep, to when it started (anything changed during
  // it is read again next minute); after a delta, to the newest change seen.
  const cursor = sweep ? startedAt.toISOString() : latest;
  await prisma.syncCursor.upsert({
    where: { spaceKey_job: { spaceKey: space.key, job: 'household-match' } },
    create: {
      spaceKey: space.key,
      job: 'household-match',
      cursor,
      ingestedAt: now(),
      sweptAt: sweep ? now() : null,
      keyId,
    },
    update: {
      cursor,
      ingestedAt: now(),
      keyId,
      ...(sweep ? { sweptAt: now() } : {}),
    },
  });
  log.info({ ...stats, cursor }, sweep ? 'swept' : 'ingested');
}

async function upsertMirror(
  prisma: PrismaClient,
  spaceKey: string,
  rows: MirrorRow[],
) {
  if (rows.length === 0) return;
  await prisma.$executeRawUnsafe(
    `INSERT INTO contact_mirror ("spaceKey", "contactId", "updatedAt", "inScope", "householdHash",
       "presenceRefId", "presenceValue", "presenceDate", "markerRefId")
     SELECT $1, * FROM unnest($2::int[], $3::text[], $4::bool[], $5::text[], $6::int[], $7::text[], $8::text[], $9::int[])
     ON CONFLICT ("spaceKey", "contactId") DO UPDATE SET
       "updatedAt" = EXCLUDED."updatedAt", "inScope" = EXCLUDED."inScope",
       "householdHash" = EXCLUDED."householdHash", "presenceRefId" = EXCLUDED."presenceRefId",
       "presenceValue" = EXCLUDED."presenceValue", "presenceDate" = EXCLUDED."presenceDate",
       "markerRefId" = EXCLUDED."markerRefId"`,
    spaceKey,
    rows.map((r) => r.contactId),
    rows.map((r) => r.updatedAt),
    rows.map((r) => r.inScope),
    rows.map((r) => r.householdHash),
    rows.map((r) => r.presenceRefId),
    rows.map((r) => r.presenceValue),
    rows.map((r) => r.presenceDate),
    rows.map((r) => r.markerRefId),
  );
}

/** A household already dirty keeps its place, attempts, and back-off. */
async function markDirty(
  prisma: PrismaClient,
  spaceKey: string,
  hashes: string[],
) {
  if (hashes.length === 0) return;
  await prisma.$executeRawUnsafe(
    `INSERT INTO dirty_household ("spaceKey", "householdHash")
     SELECT $1, unnest($2::text[])
     ON CONFLICT ("spaceKey", "householdHash") DO NOTHING`,
    spaceKey,
    hashes,
  );
}

async function membersOf(
  prisma: PrismaClient,
  spaceKey: string,
  hashes: string[],
): Promise<Map<string, MirrorRow[]>> {
  const out = new Map<string, MirrorRow[]>(hashes.map((h) => [h, []]));
  for (let i = 0; i < hashes.length; i += PAGE) {
    const rows = await prisma.contactMirror.findMany({
      where: {
        spaceKey,
        inScope: true,
        householdHash: { in: hashes.slice(i, i + PAGE) },
      },
      orderBy: { contactId: 'asc' },
    });
    for (const r of rows) out.get(r.householdHash)!.push(r);
  }
  return out;
}

/** Settled households leave the dirty table; failing ones back off, then
 *  quarantine; ones with work still pending (an interrupted run) stay. */
async function settle(
  ctx: IncrementalContext,
  hashes: string[],
  hashOf: Map<number, string>,
) {
  const { deps, space, run } = ctx;
  const now = deps.now ?? (() => new Date());
  const writes = await deps.prisma.plannedWrite.findMany({
    where: { runId: run.id },
  });
  const byHash = new Map<string, typeof writes>();
  for (const w of writes) {
    const hash = hashOf.get(w.contactId);
    if (!hash) continue;
    byHash.set(hash, [...(byHash.get(hash) ?? []), w]);
  }
  const done: string[] = [];
  for (const hash of hashes) {
    const ws = byHash.get(hash) ?? [];
    const failed = ws.find((w) => w.status === 'FAILED');
    if (failed) {
      const row = await deps.prisma.dirtyHousehold.findUniqueOrThrow({
        where: {
          spaceKey_householdHash: { spaceKey: space.key, householdHash: hash },
        },
      });
      const attempts = row.attempts + 1;
      const quarantine = attempts >= deps.env.QUARANTINE_AFTER_ATTEMPTS;
      await deps.prisma.dirtyHousehold.update({
        where: {
          spaceKey_householdHash: { spaceKey: space.key, householdHash: hash },
        },
        data: {
          attempts,
          lastError: failed.detail,
          nextAttemptAt: new Date(
            now().getTime() + 2 ** (attempts - 1) * 60_000,
          ),
          quarantinedAt: quarantine ? now() : null,
        },
      });
      continue;
    }
    const pending = ws.some(
      (w) =>
        w.status === 'PLANNED' ||
        w.status === 'APPLYING' ||
        w.status === 'APPLIED' ||
        (w.status === 'SKIPPED' && w.detail?.startsWith('run interrupted')),
    );
    if (!pending) done.push(hash);
  }
  for (let i = 0; i < done.length; i += PAGE) {
    await deps.prisma.dirtyHousehold.deleteMany({
      where: {
        spaceKey: space.key,
        householdHash: { in: done.slice(i, i + PAGE) },
      },
    });
  }
}

/**
 * A run that cannot write settles the households that need nothing and
 * re-plans the rest only after `DRY_RUN_RECHECK_MINUTES`, so a shadow day or
 * a tripped breaker does not re-plan and re-save the same writes every
 * minute. Turning writes back on makes them due at once (`setWritesEnabled`).
 */
async function defer(
  ctx: IncrementalContext,
  hashes: string[],
  hashOf: Map<number, string>,
  planned: { contactId: number }[],
) {
  const { deps, space } = ctx;
  const now = deps.now ?? (() => new Date());
  const waiting = new Set(planned.map((w) => hashOf.get(w.contactId)));
  const done = hashes.filter((h) => !waiting.has(h));
  for (let i = 0; i < done.length; i += PAGE) {
    await deps.prisma.dirtyHousehold.deleteMany({
      where: {
        spaceKey: space.key,
        householdHash: { in: done.slice(i, i + PAGE) },
      },
    });
  }
  const later = hashes.filter((h) => waiting.has(h));
  for (let i = 0; i < later.length; i += PAGE) {
    await deps.prisma.dirtyHousehold.updateMany({
      where: {
        spaceKey: space.key,
        householdHash: { in: later.slice(i, i + PAGE) },
      },
      data: {
        nextAttemptAt: new Date(
          now().getTime() + deps.env.DRY_RUN_RECHECK_MINUTES * 60_000,
        ),
      },
    });
  }
}

/** Puts a quarantined household back in line. */
export async function releaseHousehold(
  prisma: PrismaClient,
  spaceKey: string,
  target: { householdHash: string } | { contactId: number },
): Promise<string | null> {
  const hash =
    'householdHash' in target
      ? target.householdHash
      : (
          await prisma.contactMirror.findUnique({
            where: {
              spaceKey_contactId: { spaceKey, contactId: target.contactId },
            },
          })
        )?.householdHash;
  if (!hash) return null;
  const { count } = await prisma.dirtyHousehold.updateMany({
    where: { spaceKey, householdHash: hash },
    data: {
      attempts: 0,
      quarantinedAt: null,
      nextAttemptAt: new Date(),
      lastError: null,
    },
  });
  return count > 0 ? hash : null;
}

export interface Health {
  cursorAgeSeconds: number | null;
  workLagSeconds: number | null;
  quarantined: number;
}

export async function healthOf(
  prisma: PrismaClient,
  spaceKey: string,
  at: Date,
): Promise<Health> {
  const cursor = await prisma.syncCursor.findUnique({
    where: { spaceKey_job: { spaceKey, job: 'household-match' } },
  });
  // Measured from when a household became due, so one backing off after a
  // failure does not read as the whole job falling behind.
  const oldest = await prisma.dirtyHousehold.findFirst({
    where: { spaceKey, quarantinedAt: null, nextAttemptAt: { lte: at } },
    orderBy: { nextAttemptAt: 'asc' },
  });
  const quarantined = await prisma.dirtyHousehold.count({
    where: { spaceKey, quarantinedAt: { not: null } },
  });
  const age = (d: Date | null | undefined) =>
    d ? Math.round((at.getTime() - d.getTime()) / 1000) : null;
  return {
    cursorAgeSeconds: age(cursor?.ingestedAt),
    workLagSeconds: age(oldest?.nextAttemptAt),
    quarantined,
  };
}

/** Alerts for incremental and sweep runs, each posted once per problem. */
export async function incrementalAlerts(
  deps: RunDeps,
  space: Space,
  opts: RunOptions,
  result: RunResult,
): Promise<void> {
  if (!('runId' in result)) return;
  const now = (deps.now ?? (() => new Date()))();
  const s = result.stats as Partial<RunStats & IncrementalStats>;
  const where = `on space \`${space.key}\``;
  const alerts: Alert[] = [];

  if (result.status === 'FAILED') {
    const sig = createHash('sha256')
      .update(result.error ?? '')
      .digest('hex')
      .slice(0, 12);
    alerts.push(
      event(
        `run-failed:${sig}`,
        `household match failed ${where}: ${result.error}. Run \`${result.runId}\``,
        60,
      ),
    );
  }
  if (result.status === 'TRIPPED') {
    alerts.push(
      event(
        'tripped',
        `household match breaker tripped ${where}; writes are now off. Look at run \`${result.runId}\`, then \`space:writes --on\`.`,
        60,
      ),
    );
  }
  const fresh = await deps.prisma.space.findUnique({
    where: { key: space.key },
  });
  // Only an applying run knows whether writes being off is a problem; a
  // manual dry run must neither raise nor clear it.
  const unevaluated = opts.apply ? [] : ['writes-off'];
  if (
    opts.apply &&
    deps.env.QOMON_WRITES_ALLOWED &&
    fresh &&
    !fresh.writesEnabled
  ) {
    alerts.push(
      condition(
        'writes-off',
        `household match writes are off ${where}; runs only plan until they are turned back on`,
      ),
    );
  }
  if ((s.failed ?? 0) > 0) {
    alerts.push(
      event(
        'write-failures',
        `${s.failed} household match writes failed ${where}. Run \`${result.runId}\``,
        60,
      ),
    );
  }
  if ((s.invalidContacts ?? 0) > 0) {
    alerts.push(
      event(
        'invalid-contacts',
        `${s.invalidContacts} contacts ${where} failed validation and were set aside (ids in the logs)`,
      ),
    );
  }
  if ((s.changed ?? 0) > deps.env.CHANGE_SPIKE_THRESHOLD && !s.sweep) {
    const minutes = Math.ceil(
      (((s.planned ?? 0) + (s.remarks ?? 0)) * 3) / deps.env.QOMON_RPS / 60,
    );
    alerts.push(
      event(
        'change-spike',
        `${s.changed} contacts changed at once ${where}; this run plans ${(s.planned ?? 0) + (s.remarks ?? 0)} writes, about ${minutes} min`,
      ),
    );
  }
  if (s.deleteRefused) {
    alerts.push(
      event(
        'sweep-deletes-refused',
        `the sweep ${where} did not return ${s.missing} contacts it knows about, over the limit of ${deps.env.SWEEP_MAX_DELETES}; none were deleted. Check whether Qomon deleted them, then raise \`SWEEP_MAX_DELETES\` for one sweep`,
        24 * 60,
      ),
    );
  }
  if ((s.drift ?? 0) > deps.env.SWEEP_DRIFT_THRESHOLD) {
    alerts.push(
      event(
        'sweep-drift',
        `the sweep ${where} found ${s.drift} changes the minutely ingest missed; UpdatedAt is not catching some kind of change, so do not trust the incremental job until this is explained`,
        24 * 60,
      ),
    );
  }
  const limited = deps.rateLimited?.() ?? 0;
  if (limited > 0) {
    alerts.push(
      event(
        'rate-limited',
        `Qomon rate-limited the household match ${limited} times ${where}`,
      ),
    );
  }

  const hour = await deps.prisma.plannedWrite.count({
    where: {
      status: 'VERIFIED',
      run: { spaceKey: space.key },
      updatedAt: { gte: new Date(now.getTime() - 3600e3) },
    },
  });
  const day = await deps.prisma.plannedWrite.count({
    where: {
      status: 'VERIFIED',
      run: { spaceKey: space.key },
      updatedAt: { gte: new Date(now.getTime() - 24 * 3600e3) },
    },
  });
  if (hour > 50 && hour > (5 * day) / 24) {
    alerts.push(
      event(
        'write-spike',
        `${hour} household match writes in the last hour ${where}, several times the daily average`,
      ),
    );
  }

  const health = await healthOf(deps.prisma, space.key, now);
  if (
    health.cursorAgeSeconds !== null &&
    health.cursorAgeSeconds > deps.env.INGEST_LAG_ALERT_MINUTES * 60
  ) {
    alerts.push(
      condition(
        'ingest-lag',
        `household match ingest ${where} has not completed for ${Math.round(health.cursorAgeSeconds / 60)} min`,
      ),
    );
  }
  if (
    health.workLagSeconds !== null &&
    health.workLagSeconds > deps.env.WORK_LAG_ALERT_MINUTES * 60
  ) {
    alerts.push(
      condition(
        'work-lag',
        `household match work ${where} is ${Math.round(health.workLagSeconds / 60)} min behind`,
      ),
    );
  }
  if (health.quarantined > 0) {
    alerts.push(
      condition(
        'quarantine',
        `${health.quarantined} households ${where} are quarantined after repeated failures; see \`dirty_household\`, then \`job release\``,
      ),
    );
  }

  await syncAlerts(
    deps.prisma,
    space.key,
    alerts,
    deps.notify,
    deps.log,
    now,
    unevaluated,
  );
}
