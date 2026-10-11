import type { QomonApi, QomonContact, QomonForm } from '@trellis/qomon-client';
import { InMemoryQomon } from '@trellis/qomon-client/fake';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../env.js';
import { tryAdvisoryLock } from '../../lock.js';
import { runStatus } from '../../report.js';
import { makeSpace, resetDb, testEnv, testPrisma } from '../../test/db.js';
import {
  runHouseholdMatch,
  UsageError,
  type RunDeps,
  type RunOptions,
} from './run.js';

const prisma = testPrisma();
afterAll(() => prisma.$disconnect());

const FORM: QomonForm = {
  id: 1,
  label: 'Presence',
  type: 'radio',
  refvalues: [
    { id: 11, value: 'present', label: 'present' },
    { id: 12, value: 'absent', label: 'absent' },
    { id: 13, value: 'refus', label: 'refusal' },
    { id: 14, value: 'repasse', label: 'repasse' },
  ],
};

function presence(value: string) {
  const ref = FORM.refvalues.find((r) => r.value === value)!;
  return [
    {
      form_id: FORM.id,
      form_ref_id: ref.id,
      data: value,
      date: '2026-10-01T15:00:00Z',
    },
  ];
}

const MARKER: QomonForm = {
  id: 2,
  label: 'Presence source',
  type: 'radio',
  refvalues: [
    { id: 21, value: 'household_match', label: 'Household match' },
    { id: 22, value: 'recanvassed', label: 'Canvassed after household match' },
  ],
};
const MARK = [{ form_id: MARKER.id, form_ref_id: 21, data: 'household_match' }];

/** the household value and its marker, as the job writes them */
function householdWrite(c: QomonContact): boolean {
  return (
    presenceValue(c) === 'absent' &&
    (c.custom_fields?.some((f) => f.form_ref_id === 21) ?? false)
  );
}

function presenceValue(c: QomonContact): string | undefined {
  return c.formdatas?.find((f) => f.form_id === FORM.id)?.data ?? undefined;
}

/** The fake with some methods replaced. Every other call goes to the fake
 *  itself, so its state (including queued upserts) stays in one place. */
function withOverrides(overrides: Partial<QomonApi>): QomonApi {
  return new Proxy(qomon, {
    get(target, prop, receiver) {
      if (prop in overrides) return overrides[prop as keyof QomonApi];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

let qomon: InMemoryQomon;
let ids: {
  knocked: number;
  housemate: number;
  roommate: number;
  neighbour: number;
  alreadyAbsent: number;
};

function seed(q: InMemoryQomon) {
  const at = (housenumber: string) => ({
    housenumber,
    street: 'Example St',
    city: 'Exampleton',
  });
  ids = {
    knocked: q.seedContact({
      firstname: 'Ada',
      address: at('345'),
      formdatas: presence('present'),
    }).id!,
    housemate: q.seedContact({ firstname: 'Bo', address: at('345') }).id!,
    roommate: q.seedContact({
      firstname: 'Cy',
      address: { ...at('345'), street: 'Example Street' },
    }).id!,
    alreadyAbsent: q.seedContact({
      firstname: 'Di',
      address: at('345'),
      formdatas: presence('absent'),
    }).id!,
    neighbour: q.seedContact({ firstname: 'Ed', address: at('347') }).id!,
  };
}

function deps(
  overrides: Partial<RunDeps> & { env?: Env; api?: QomonApi } = {},
): RunDeps & {
  notify: ReturnType<typeof vi.fn>;
} {
  let clock = Date.parse('2026-10-10T12:00:00Z');
  return {
    prisma,
    env: overrides.env ?? testEnv(),
    log: pino({ level: 'silent' }),
    qomonFor: () => overrides.api ?? qomon,
    lock: async () => ({ release: async () => {} }),
    notify: vi.fn(async () => {}),
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    ...overrides,
  } as RunDeps & { notify: ReturnType<typeof vi.fn> };
}

const hourly: RunOptions = {
  spaceKey: 'test-space',
  apply: true,
  backfill: false,
};

beforeEach(async () => {
  await resetDb(prisma);
  qomon = new InMemoryQomon({
    forms: { presence_status: [FORM], custom_fields: [MARKER] },
  });
  seed(qomon);
});

describe('household match run', () => {
  it('writes, verifies, and change-logs the household value', async () => {
    await makeSpace(prisma);
    const d = deps();
    const result = await runHouseholdMatch(d, hourly);

    expect(result).toMatchObject({ status: 'SUCCEEDED', applying: true });
    expect(result).toMatchObject({
      stats: { planned: 2, applied: 2, verified: 2, failed: 0, skipped: 0 },
    });
    expect(householdWrite(await qomon.getContact(ids.housemate))).toBe(true);
    expect(householdWrite(await qomon.getContact(ids.roommate))).toBe(true);
    expect(presenceValue(await qomon.getContact(ids.alreadyAbsent))).toBe(
      'absent',
    );
    expect(
      presenceValue(await qomon.getContact(ids.neighbour)),
    ).toBeUndefined();

    const entries = await prisma.changeLogEntry.findMany({
      where: { subjectType: 'QomonContact' },
    });
    expect(entries.map((e) => Number(e.subjectId)).sort()).toEqual(
      [ids.housemate, ids.roommate].sort(),
    );
    expect(entries[0]).toMatchObject({
      actor: 'household-match',
      before: { presence: null },
    });
    // a successful run, writes or not, posts nothing
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('records the Presence date each write got, for telling its writes from later knocks', async () => {
    await makeSpace(prisma);
    await runHouseholdMatch(deps(), hourly);
    const write = await prisma.plannedWrite.findFirstOrThrow({
      where: { contactId: ids.housemate },
    });
    const current = (await qomon.getContact(ids.housemate)).formdatas!.find(
      (f) => f.form_id === FORM.id,
    )!;
    expect(write.writtenPresenceDate).toBe(current.date);
  });

  it('fails a write that lands without its marker', async () => {
    await makeSpace(prisma);
    const api: QomonApi = withOverrides({
      upsertContact: ({
        custom_fields: _dropped,
        ...rest
      }: Parameters<QomonApi['upsertContact']>[0]) => qomon.upsertContact(rest),
    });
    const d = deps({ api });
    const result = await runHouseholdMatch(d, hourly);
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      stats: { applied: 2, verified: 0, failed: 2 },
    });
    // failed writes are what Slack is for, even when the run itself succeeds
    expect(d.notify).toHaveBeenCalledOnce();
    expect(d.notify.mock.calls[0]![0]).toMatch(/failed 2/);
    expect(
      (
        await prisma.plannedWrite.findFirstOrThrow({
          where: { status: 'FAILED' },
        })
      ).detail,
    ).toBe('the household value is there without its marker');
  });

  it('re-marks a contact a person visits after the job wrote it, leaving their Presence', async () => {
    await makeSpace(prisma);
    await runHouseholdMatch(deps(), hourly);
    // a canvasser records the housemate as present; the marker stays
    qomon.seedContact({
      ...(await qomon.getContact(ids.housemate)),
      formdatas: presence('present'),
    });

    const second = await runHouseholdMatch(deps(), hourly);
    expect(second).toMatchObject({
      status: 'SUCCEEDED',
      stats: { planned: 0, remarks: 1, verified: 1 },
    });
    const after = await qomon.getContact(ids.housemate);
    expect(presenceValue(after)).toBe('present');
    expect(
      after.custom_fields?.find((f) => f.form_id === MARKER.id)?.form_ref_id,
    ).toBe(22);
    const entry = await prisma.changeLogEntry.findFirstOrThrow({
      where: {
        subjectId: String(ids.housemate),
        before: { equals: { presenceSource: 'household_match' } },
      },
    });
    expect(entry.after).toEqual({ presenceSource: 'recanvassed' });

    // re-marking does not hide the job's other writes from it
    const third = await runHouseholdMatch(deps(), hourly);
    expect(third).toMatchObject({ stats: { planned: 0, remarks: 0 } });
    expect(householdWrite(await qomon.getContact(ids.roommate))).toBe(true);
  });

  it('is idempotent: the next run plans nothing and stays quiet', async () => {
    await makeSpace(prisma);
    await runHouseholdMatch(deps(), hourly);
    const d = deps();
    const second = await runHouseholdMatch(d, hourly);
    expect(second).toMatchObject({
      status: 'SUCCEEDED',
      stats: { planned: 0 },
    });
    expect(d.notify).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the environment',
      { env: testEnv({ QOMON_WRITES_ALLOWED: false }) },
      {},
      hourly,
    ],
    ['the space', {}, { writesEnabled: false }, hourly],
    ['the run', {}, {}, { ...hourly, apply: false }],
  ])(
    'plans but writes nothing unless %s allows it',
    async (_name, depOverrides, spaceData, opts) => {
      await makeSpace(prisma, spaceData);
      const d = deps(depOverrides);
      const result = await runHouseholdMatch(d, opts);
      expect(result).toMatchObject({
        status: 'SUCCEEDED',
        applying: false,
        stats: { planned: 2 },
      });
      expect(
        presenceValue(await qomon.getContact(ids.housemate)),
      ).toBeUndefined();
      expect(
        await prisma.plannedWrite.count({ where: { status: 'PLANNED' } }),
      ).toBe(2);
      expect(d.notify).not.toHaveBeenCalled();
    },
  );

  it('trips when an hourly run plans more than the limit, and turns the space off', async () => {
    await makeSpace(prisma);
    const d = deps({ env: testEnv({ MAX_WRITES_PER_RUN: 1 }) });
    const result = await runHouseholdMatch(d, hourly);
    expect(result).toMatchObject({
      status: 'TRIPPED',
      stats: { planned: 2, overLimit: true },
    });
    expect(
      presenceValue(await qomon.getContact(ids.housemate)),
    ).toBeUndefined();
    expect(
      (await prisma.space.findUniqueOrThrow({ where: { key: 'test-space' } }))
        .writesEnabled,
    ).toBe(false);
    expect(
      await prisma.changeLogEntry.count({ where: { subjectType: 'Space' } }),
    ).toBe(1);
    expect(d.notify.mock.calls[0]![0]).toMatch(/Writes are now off/);
  });

  it('a backfill over --max-writes writes nothing but leaves the space on', async () => {
    await makeSpace(prisma);
    const result = await runHouseholdMatch(deps(), {
      ...hourly,
      backfill: true,
      maxWrites: 1,
    });
    expect(result).toMatchObject({ status: 'TRIPPED' });
    expect(
      presenceValue(await qomon.getContact(ids.housemate)),
    ).toBeUndefined();
    expect(
      (await prisma.space.findUniqueOrThrow({ where: { key: 'test-space' } }))
        .writesEnabled,
    ).toBe(true);
  });

  it('a backfill within --max-writes applies past MAX_WRITES_PER_RUN', async () => {
    await makeSpace(prisma);
    const d = deps({ env: testEnv({ MAX_WRITES_PER_RUN: 1 }) });
    const result = await runHouseholdMatch(d, {
      ...hourly,
      backfill: true,
      maxWrites: 2,
    });
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      stats: { verified: 2 },
    });
    expect(await prisma.jobRun.findFirst()).toMatchObject({ kind: 'BACKFILL' });
  });

  it('refuses to apply a backfill without --max-writes, but dry-runs one', async () => {
    await makeSpace(prisma);
    await expect(
      runHouseholdMatch(deps(), { ...hourly, backfill: true }),
    ).rejects.toBeInstanceOf(UsageError);
    const dry = await runHouseholdMatch(deps(), {
      ...hourly,
      apply: false,
      backfill: true,
    });
    expect(dry).toMatchObject({
      status: 'SUCCEEDED',
      applying: false,
      stats: { planned: 2 },
    });
  });

  it('skips a contact that got a Presence after the fetch', async () => {
    await makeSpace(prisma);
    // a canvasser records a visit between the search and the write
    const api: QomonApi = withOverrides({
      searchContacts: async (
        params: Parameters<QomonApi['searchContacts']>[0],
      ) => {
        const page = await qomon.searchContacts(params);
        const current = await qomon.getContact(ids.housemate);
        qomon.seedContact({ ...current, formdatas: presence('repasse') });
        return page;
      },
    });
    const result = await runHouseholdMatch(deps({ api }), hourly);
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      stats: { planned: 2, skipped: 1, verified: 1 },
    });
    expect(presenceValue(await qomon.getContact(ids.housemate))).toBe(
      'repasse',
    );
    expect(
      await prisma.plannedWrite.findFirst({
        where: { contactId: ids.housemate },
      }),
    ).toMatchObject({
      status: 'SKIPPED',
    });
  });

  it('a write that never shows up fails, and too many failures trip the breaker', async () => {
    await makeSpace(prisma);
    const api: QomonApi = withOverrides({
      upsertContact: async () => {},
    });
    const d = deps({ api, env: testEnv({ MIN_WRITES_FOR_FAILED_SHARE: 2 }) });
    const result = await runHouseholdMatch(d, hourly);
    expect(result).toMatchObject({
      status: 'TRIPPED',
      stats: { applied: 2, verified: 0, failed: 2 },
    });
    const failed = await prisma.plannedWrite.findMany({
      where: { status: 'FAILED' },
    });
    expect(failed.map((w) => w.detail)).toEqual([
      'not visible after 30s',
      'not visible after 30s',
    ]);
    expect(
      (await prisma.space.findUniqueOrThrow({ where: { key: 'test-space' } }))
        .writesEnabled,
    ).toBe(false);
  });

  it('fails without planning when the household value is not on the form', async () => {
    await makeSpace(prisma, { householdValue: 'Absent (other)' });
    const d = deps();
    const result = await runHouseholdMatch(d, hourly);
    expect(result).toMatchObject({ status: 'FAILED' });
    expect('error' in result && result.error).toMatch(
      /not on the Presence form/,
    );
    expect(await prisma.plannedWrite.count()).toBe(0);
    expect(d.notify).toHaveBeenCalledOnce();
  });

  it('does nothing after activeUntil', async () => {
    await makeSpace(prisma, { activeUntil: new Date('2026-10-01T00:00:00Z') });
    expect(await runHouseholdMatch(deps(), hourly)).toEqual({
      status: 'inactive',
    });
    expect(await prisma.jobRun.count()).toBe(0);
  });

  it('exits when another run holds the lock', async () => {
    await makeSpace(prisma);
    expect(
      await runHouseholdMatch(deps({ lock: async () => null }), hourly),
    ).toEqual({ status: 'locked' });
    expect(await prisma.jobRun.count()).toBe(0);
  });
});

describe('incremental runs', () => {
  const CURSOR = new Date('2026-10-10T11:00:00Z');
  const OLD = '2026-10-01T00:00:00Z';
  const incremental: RunOptions = { ...hourly, incremental: true };
  let inc: {
    oldHousemate: number;
    knock: number;
    numberInStreet: number;
    neighbour: number;
  };

  // Example St was knocked long ago; Sample Rd was knocked after the cursor.
  beforeEach(() => {
    qomon = new InMemoryQomon({
      forms: { presence_status: [FORM], custom_fields: [MARKER] },
    });
    const old = (firstname: string, address: Record<string, string>) =>
      qomon.seedContact({ firstname, address, UpdatedAt: OLD }).id!;
    qomon.seedContact({
      firstname: 'Ada',
      address: { housenumber: '345', street: 'Example St' },
      formdatas: presence('present'),
      UpdatedAt: OLD,
    });
    inc = {
      oldHousemate: old('Bo', { housenumber: '345', street: 'Example St' }),
      knock: qomon.seedContact({
        firstname: 'Cy',
        address: { housenumber: '12', street: 'Sample Rd' },
        formdatas: presence('refus'),
        UpdatedAt: '2026-10-10T11:30:00Z',
      }).id!,
      // the number in the street field, and the street spelled out
      numberInStreet: old('Di', { street: '12 Sample Road' }),
      neighbour: old('Ed', { housenumber: '14', street: 'Sample Rd' }),
    };
    old('Fa', { housenumber: '7', street: 'Other Ave' });
  });

  it('with no cursor yet fetches everything, then sets the cursor', async () => {
    await makeSpace(prisma);
    const result = await runHouseholdMatch(deps(), incremental);
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      stats: {
        scope: 'full',
        fallback: 'no cursor yet',
        fetched: 6,
        planned: 2,
      },
    });
    const space = await prisma.space.findUniqueOrThrow({
      where: { key: 'test-space' },
    });
    expect(space.changedCursor?.toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect((await prisma.jobRun.findFirstOrThrow()).kind).toBe('INCREMENTAL');
  });

  it('fetches only changed contacts and their streets', async () => {
    await makeSpace(prisma, { changedCursor: CURSOR });
    const result = await runHouseholdMatch(deps(), incremental);
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      stats: {
        scope: 'incremental',
        changed: 1,
        streets: 1,
        fetched: 3,
        planned: 1,
        verified: 1,
      },
    });
    expect(householdWrite(await qomon.getContact(inc.numberInStreet))).toBe(
      true,
    );
    expect(
      presenceValue(await qomon.getContact(inc.neighbour)),
    ).toBeUndefined();
    // knocked before the cursor: a full run's job, not this one's
    expect(
      presenceValue(await qomon.getContact(inc.oldHousemate)),
    ).toBeUndefined();
  });

  it("does not search the streets of the job's own writes", async () => {
    await makeSpace(prisma, { changedCursor: CURSOR });
    await runHouseholdMatch(deps(), incremental);
    const next = await runHouseholdMatch(
      deps({ now: () => new Date('2026-10-10T12:01:00Z') }),
      incremental,
    );
    expect(next).toMatchObject({
      status: 'SUCCEEDED',
      stats: { scope: 'incremental', changed: 1, streets: 0, planned: 0 },
    });
  });

  it('keeps the cursor while planned writes are unwritten, and moves it once nothing is left', async () => {
    await makeSpace(prisma, { changedCursor: CURSOR });
    const cursor = async () =>
      (await prisma.space.findUniqueOrThrow({ where: { key: 'test-space' } }))
        .changedCursor;

    await runHouseholdMatch(deps(), { ...incremental, apply: false });
    expect(await cursor()).toEqual(CURSOR);

    await runHouseholdMatch(deps(), incremental);
    expect(await cursor()).toEqual(new Date('2026-10-10T12:00:00Z'));
  });

  it('falls back to a full fetch when too many contacts changed', async () => {
    await makeSpace(prisma, { changedCursor: CURSOR });
    const changed = Array.from({ length: 2001 }, (_, i) => ({
      id: 900_000 + i,
    }));
    const many = withOverrides({
      searchContacts: async (params) => {
        if (!JSON.stringify(params.query).includes('UpdatedAt'))
          return qomon.searchContacts(params);
        const page = params.page ?? 0;
        const perPage = params.perPage ?? 1000;
        return changed.slice(page * perPage, (page + 1) * perPage);
      },
    });
    const result = await runHouseholdMatch(deps({ api: many }), {
      ...incremental,
      apply: false,
    });
    expect(result).toMatchObject({
      stats: { scope: 'full', fallback: '2001 contacts changed, over 2000' },
    });
  });

  it('refuses --incremental with --backfill', async () => {
    await makeSpace(prisma);
    await expect(
      runHouseholdMatch(deps(), { ...incremental, backfill: true }),
    ).rejects.toThrow(UsageError);
  });

  it('posts the first of a run of failures, not every one', async () => {
    await makeSpace(prisma, { changedCursor: CURSOR });
    const down = withOverrides({
      searchContacts: async () => {
        throw new Error('Qomon is down');
      },
    });
    const d = deps({ api: down });
    await runHouseholdMatch(d, incremental);
    await runHouseholdMatch(d, incremental);
    expect(d.notify).toHaveBeenCalledTimes(1);

    await runHouseholdMatch(deps(), incremental);
    await runHouseholdMatch(d, incremental);
    expect(d.notify).toHaveBeenCalledTimes(2);
  });
});

describe('progress and restarts', () => {
  it('saves progress on the run, and status shows it', async () => {
    await makeSpace(prisma);
    const result = await runHouseholdMatch(deps(), hourly);
    const run = await prisma.jobRun.findUniqueOrThrow({
      where: { id: 'runId' in result ? result.runId : '' },
    });
    expect(run.stats).toMatchObject({ progress: { done: 2, total: 2 } });
    expect(await runStatus(prisma, 'test-space')).toMatch(
      /progress 2\/2 \(100%\)/,
    );
  });

  it('a successful backfill posts nothing to Slack', async () => {
    await makeSpace(prisma);
    const d = deps();
    const result = await runHouseholdMatch(d, {
      ...hourly,
      backfill: true,
      maxWrites: 10,
    });
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      stats: { verified: 2 },
    });
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('stops cleanly on a signal: verifies what was sent, and the next run does the rest', async () => {
    await makeSpace(prisma);
    const stop = new AbortController();
    const api: QomonApi = withOverrides({
      upsertContact: async (c: Parameters<QomonApi['upsertContact']>[0]) => {
        await qomon.upsertContact(c);
        stop.abort();
      },
    });
    const stopped = deps({ api, signal: stop.signal });
    const first = await runHouseholdMatch(stopped, hourly);
    // a stop on purpose is not a failure
    expect(stopped.notify).not.toHaveBeenCalled();
    expect(first).toMatchObject({
      status: 'INTERRUPTED',
      stats: { applied: 1, verified: 1 },
    });
    expect(
      await prisma.plannedWrite.count({ where: { status: 'APPLYING' } }),
    ).toBe(0);
    expect(
      await prisma.plannedWrite.findFirst({ where: { status: 'SKIPPED' } }),
    ).toMatchObject({
      detail: 'run interrupted before this write',
    });

    const second = await runHouseholdMatch(deps(), hourly);
    expect(second).toMatchObject({
      status: 'SUCCEEDED',
      stats: { planned: 1, verified: 1 },
    });
    expect(householdWrite(await qomon.getContact(ids.housemate))).toBe(true);
    expect(householdWrite(await qomon.getContact(ids.roommate))).toBe(true);
  });

  it('settles a run that was killed outright before planning again', async () => {
    const space = await makeSpace(prisma);
    // a killed run: one write landed but was never read back, one was sent
    // and dropped, one never attempted
    qomon.seedContact({
      ...(await qomon.getContact(ids.roommate)),
      formdatas: presence('absent'),
      custom_fields: MARK,
    });
    const dead = await prisma.jobRun.create({
      data: {
        job: 'household-match',
        spaceKey: space.key,
        kind: 'BACKFILL',
        applying: true,
      },
    });
    const write = (
      contactId: number,
      status: 'APPLYING' | 'APPLIED' | 'PLANNED',
    ) => ({
      runId: dead.id,
      contactId,
      field: 'presence',
      valueAfter: 'absent',
      triggerContactId: ids.knocked,
      reason: 'test',
      status,
    });
    await prisma.plannedWrite.createMany({
      data: [
        write(ids.roommate, 'APPLYING'),
        write(ids.housemate, 'APPLIED'),
        write(ids.neighbour, 'PLANNED'),
      ],
    });

    const result = await runHouseholdMatch(deps(), hourly);
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      stats: { reconciled: 2, planned: 1, verified: 1 },
    });
    expect(
      await prisma.jobRun.findUniqueOrThrow({ where: { id: dead.id } }),
    ).toMatchObject({
      status: 'INTERRUPTED',
      error: expect.stringMatching(/^abandoned; settled by run /),
    });
    const settled = await prisma.plannedWrite.findMany({
      where: { runId: dead.id },
      orderBy: { contactId: 'asc' },
    });
    expect(
      Object.fromEntries(settled.map((w) => [w.contactId, w.status])),
    ).toEqual({
      [ids.roommate]: 'VERIFIED',
      [ids.housemate]: 'FAILED',
      [ids.neighbour]: 'SKIPPED',
    });
  });
});

describe('advisory lock', () => {
  it('admits one holder at a time', async () => {
    const url = process.env.DATABASE_URL!;
    const first = await tryAdvisoryLock(url, 'household-match:lock-test');
    expect(first).not.toBeNull();
    expect(await tryAdvisoryLock(url, 'household-match:lock-test')).toBeNull();
    await first!.release();
    const again = await tryAdvisoryLock(url, 'household-match:lock-test');
    expect(again).not.toBeNull();
    await again!.release();
  });
});
