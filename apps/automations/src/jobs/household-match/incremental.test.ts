import type { QomonApi, QomonContact, QomonForm } from '@trellis/qomon-client';
import { InMemoryQomon } from '@trellis/qomon-client/fake';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncAlerts, condition, event } from '../../alerts.js';
import type { Env } from '../../env.js';
import { makeSpace, resetDb, testEnv, testPrisma } from '../../test/db.js';
import { releaseHousehold } from './incremental.js';
import { runHouseholdMatch, type RunDeps, type RunOptions } from './run.js';

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
const MARKER: QomonForm = {
  id: 2,
  label: 'Presence source',
  type: 'radio',
  refvalues: [
    { id: 21, value: 'household_match', label: 'Household match' },
    { id: 22, value: 'recanvassed', label: 'Recanvassed' },
  ],
};
const VALUES = ['present', 'absent', 'refus', 'repasse'];
const ADDRESSES = [
  { housenumber: '345', street: 'Example St' },
  { housenumber: '12-345', street: 'Example St' },
  { housenumber: '347', street: 'Example Street' },
  { housenumber: '9', street: 'Demo Ln' },
  { housenumber: '9', door: 'B', street: 'Demo Lane' },
  { street: 'Nowhere Rd' },
];

const fake = () =>
  new InMemoryQomon({
    forms: { presence_status: [FORM], custom_fields: [MARKER] },
  });

function canvass(q: InMemoryQomon, id: number, value: string) {
  return q.upsertContact({ id, name_presences: [{ id: FORM.id, value }] });
}

function stateOf(c: QomonContact) {
  const p = c.formdatas?.find((f) => f.form_id === FORM.id)?.data ?? null;
  const m =
    c.custom_fields?.find((f) => f.form_id === MARKER.id)?.form_ref_id ?? null;
  return `${p ?? '-'}/${m === 21 ? 'household_match' : m === 22 ? 'recanvassed' : '-'}`;
}

function deps(
  qomon: QomonApi,
  env: Env = testEnv({ INCREMENTAL_OVERLAP_SECONDS: 0 }),
) {
  return {
    prisma,
    env,
    log: pino({ level: 'silent' }),
    qomonFor: () => qomon,
    lock: async () => ({ release: async () => {} }),
    notify: vi.fn(async () => {}),
    sleep: async () => {},
  } as RunDeps & { notify: ReturnType<typeof vi.fn> };
}

const incremental = (spaceKey: string): RunOptions => ({
  spaceKey,
  apply: true,
  backfill: false,
  mode: 'incremental',
});
const sweep = (spaceKey: string): RunOptions => ({
  spaceKey,
  apply: true,
  backfill: false,
  mode: 'sweep',
});
const full = (spaceKey: string): RunOptions => ({
  spaceKey,
  apply: true,
  backfill: false,
});

/** Deterministic, so a failure reproduces. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

beforeEach(() => resetDb(prisma));

describe('incremental household match', () => {
  it('ends in the same state as the full job over random histories', async () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      await resetDb(prisma);
      await makeSpace(prisma, { key: 'full' });
      await makeSpace(prisma, { key: 'inc' });
      const a = fake();
      const b = fake();
      const both = async (fn: (q: InMemoryQomon) => unknown) => {
        await fn(a);
        await fn(b);
      };
      const random = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]!;
      let nextId = 1;
      const ids: number[] = [];

      for (let step = 0; step < 14; step += 1) {
        const roll = random();
        if (roll < 0.35 || ids.length < 3) {
          const id = nextId++;
          ids.push(id);
          const address = { city: 'Testville', ...pick(ADDRESSES) };
          await both((q) =>
            q.seedContact({ id, firstname: `P${id}`, address }),
          );
          if (random() < 0.4) {
            const value = pick(VALUES);
            await both((q) => canvass(q, id, value));
          }
        } else if (roll < 0.7) {
          const id = pick(ids);
          const value = pick(VALUES);
          await both((q) => canvass(q, id, value));
        } else if (roll < 0.85) {
          const id = pick(ids);
          const address = { city: 'Testville', ...pick(ADDRESSES) };
          await both(async (q) =>
            q.seedContact({ ...(await q.getContact(id)), address }),
          );
        } else {
          const id = pick(ids);
          ids.splice(ids.indexOf(id), 1);
          await both((q) => q.removeContact(id));
        }
        // a few calls so queued upserts land in both fakes
        a.flushUpserts();
        b.flushUpserts();

        // deletions are only visible to a sweep, as in Qomon
        const deleted = roll >= 0.85;
        const full1 = await runHouseholdMatch(deps(a), full('full'));
        const inc1 = await runHouseholdMatch(
          deps(b),
          deleted ? sweep('inc') : incremental('inc'),
        );
        expect(full1.status, `seed ${seed} step ${step}`).toBe('SUCCEEDED');
        expect(inc1.status, `seed ${seed} step ${step}`).toBe('SUCCEEDED');

        const states = async (q: InMemoryQomon) =>
          Object.fromEntries(
            await Promise.all(
              ids.map(async (id) => [id, stateOf(await q.getContact(id))]),
            ),
          );
        expect(await states(b), `seed ${seed} step ${step}`).toEqual(
          await states(a),
        );
      }
    }
  }, 120_000);

  it('seeds the mirror with a sweep, then reads only what changed', async () => {
    await makeSpace(prisma);
    const q = fake();
    const ids = [1, 2, 3].map(
      (id) =>
        q.seedContact({ id, address: { city: 'Testville', ...ADDRESSES[0]! } })
          .id!,
    );
    await canvass(q, ids[0]!, 'present');
    q.flushUpserts();

    const seed = await runHouseholdMatch(deps(q), incremental('test-space'));
    expect(seed).toMatchObject({
      status: 'SUCCEEDED',
      stats: { sweep: true, changed: 3, planned: 2, verified: 2 },
    });
    const mirror = await prisma.contactMirror.findMany();
    expect(mirror).toHaveLength(3);
    expect(JSON.stringify(mirror)).not.toMatch(/Example|345/);

    const quiet = await runHouseholdMatch(deps(q), incremental('test-space'));
    expect(quiet).toMatchObject({
      status: 'SUCCEEDED',
      stats: { sweep: false, planned: 0, remarks: 0 },
    });
    expect(await prisma.dirtyHousehold.count()).toBe(0);
  });

  it('a dry run plans but leaves the households dirty', async () => {
    await makeSpace(prisma, { writesEnabled: false });
    const q = fake();
    q.seedContact({ id: 1, address: { city: 'Testville', ...ADDRESSES[0]! } });
    q.seedContact({ id: 2, address: { city: 'Testville', ...ADDRESSES[0]! } });
    await canvass(q, 1, 'present');
    q.flushUpserts();
    const result = await runHouseholdMatch(deps(q), incremental('test-space'));
    expect(result).toMatchObject({ applying: false, stats: { planned: 1 } });
    expect(await prisma.dirtyHousehold.count()).toBe(1);
  });

  it('a failing household backs off, then is quarantined and alerted once, while others proceed', async () => {
    await makeSpace(prisma);
    const q = fake();
    for (const [id, a] of [
      [1, 0],
      [2, 0],
      [3, 3],
      [4, 3],
    ] as const) {
      q.seedContact({ id, address: { city: 'Testville', ...ADDRESSES[a]! } });
    }
    await canvass(q, 1, 'present');
    await canvass(q, 3, 'present');
    q.flushUpserts();
    // every write to contact 2 is dropped
    const api = new Proxy(q, {
      get(target, prop) {
        if (prop === 'upsertContact') {
          return async (c: Parameters<QomonApi['upsertContact']>[0]) =>
            c.id === 2 ? undefined : target.upsertContact(c);
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as QomonApi;
    const env = testEnv({
      INCREMENTAL_OVERLAP_SECONDS: 0,
      VERIFY_TIMEOUT_SECONDS: 0,
      MIN_WRITES_FOR_FAILED_SHARE: 100,
    });

    const first = await runHouseholdMatch(
      deps(api, env),
      incremental('test-space'),
    );
    expect(first).toMatchObject({ stats: { verified: 1, failed: 1 } });
    expect(stateOf(await q.getContact(4))).toBe('absent/household_match');
    let row = await prisma.dirtyHousehold.findFirstOrThrow();
    expect(row).toMatchObject({ attempts: 1, quarantinedAt: null });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    let d = deps(api, env);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await prisma.dirtyHousehold.updateMany({
        data: { nextAttemptAt: new Date(0) },
      });
      d = deps(api, env);
      await runHouseholdMatch(d, incremental('test-space'));
    }
    row = await prisma.dirtyHousehold.findFirstOrThrow();
    expect(row).toMatchObject({
      attempts: 5,
      lastError: 'not visible after 0s',
    });
    expect(row.quarantinedAt).not.toBeNull();
    expect(d.notify.mock.calls.map((c) => c[0]).join('\n')).toMatch(
      /1 households .* are quarantined/,
    );

    // quarantined: not retried, and the alert does not repeat
    await prisma.dirtyHousehold.updateMany({
      data: { nextAttemptAt: new Date(0) },
    });
    const quiet = deps(api, env);
    const after = await runHouseholdMatch(quiet, incremental('test-space'));
    expect(after).toMatchObject({ stats: { dirtyHouseholds: 0 } });
    expect(quiet.notify.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(
      /quarantined/,
    );

    expect(await releaseHousehold(prisma, 'test-space', { contactId: 2 })).toBe(
      row.householdHash,
    );
    const released = deps(q, env);
    const retry = await runHouseholdMatch(released, incremental('test-space'));
    expect(retry).toMatchObject({ stats: { verified: 1 } });
    expect(await prisma.dirtyHousehold.count()).toBe(0);
    expect(released.notify.mock.calls.map((c) => c[0]).join('\n')).toMatch(
      /resolved: quarantine/,
    );
  });

  it('a run that fails before ingest finishes leaves the cursor where it was', async () => {
    await makeSpace(prisma);
    const q = fake();
    q.seedContact({ id: 1, address: { city: 'Testville', ...ADDRESSES[0]! } });
    await runHouseholdMatch(deps(q), incremental('test-space'));
    const before = await prisma.syncCursor.findFirstOrThrow();

    q.seedContact({ id: 2, address: { city: 'Testville', ...ADDRESSES[0]! } });
    const broken = new Proxy(q, {
      get(target, prop) {
        if (prop === 'searchContacts')
          return async () => Promise.reject(new Error('Qomon is down'));
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as QomonApi;
    const d = deps(broken);
    const failed = await runHouseholdMatch(d, incremental('test-space'));
    expect(failed).toMatchObject({ status: 'FAILED' });
    expect((await prisma.syncCursor.findFirstOrThrow()).cursor).toBe(
      before.cursor,
    );
    expect(d.notify.mock.calls[0]![0]).toMatch(/Qomon is down/);

    const recovered = await runHouseholdMatch(
      deps(q),
      incremental('test-space'),
    );
    expect(recovered).toMatchObject({ status: 'SUCCEEDED' });
    expect(await prisma.contactMirror.count()).toBe(2);
  });

  it('a sweep removes deleted contacts and reports changes the ingest missed', async () => {
    await makeSpace(prisma);
    const q = fake();
    for (const id of [1, 2, 3])
      q.seedContact({ id, address: { city: 'Testville', ...ADDRESSES[0]! } });
    await runHouseholdMatch(deps(q), incremental('test-space'));

    q.removeContact(3);
    // a change the ingest never saw: the mirror says contact 2 has a
    // Presence, with an UpdatedAt from before the cursor
    await prisma.contactMirror.updateMany({
      where: { contactId: 2 },
      data: {
        presenceRefId: 11,
        presenceValue: 'present',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const d = deps(
      q,
      testEnv({ INCREMENTAL_OVERLAP_SECONDS: 0, SWEEP_DRIFT_THRESHOLD: 0 }),
    );
    const result = await runHouseholdMatch(d, sweep('test-space'));
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      stats: { sweep: true, deleted: 1, drift: 1 },
    });
    expect(await prisma.contactMirror.count()).toBe(2);
    expect(d.notify.mock.calls[0]![0]).toMatch(
      /found 1 changes the minutely ingest missed/,
    );
  });

  it('alerts that writes are off while they are, and once more when they are back', async () => {
    await makeSpace(prisma, { writesEnabled: false });
    const q = fake();
    const first = deps(q);
    await runHouseholdMatch(first, incremental('test-space'));
    await runHouseholdMatch(deps(q), incremental('test-space'));
    expect(first.notify.mock.calls[0]![0]).toMatch(/writes are off/);

    const second = deps(q);
    await runHouseholdMatch(second, incremental('test-space'));
    expect(second.notify).not.toHaveBeenCalled();

    await prisma.space.update({
      where: { key: 'test-space' },
      data: { writesEnabled: true },
    });
    const third = deps(q);
    await runHouseholdMatch(third, incremental('test-space'));
    expect(third.notify.mock.calls[0]![0]).toMatch(/resolved: writes-off/);
  });
});

describe('syncAlerts', () => {
  const log = pino({ level: 'silent' });

  it('posts a condition once, and once more when it clears', async () => {
    const notify = vi.fn(async (_text: string) => {});
    const lag = condition('ingest-lag', 'ingest is behind');
    await syncAlerts(prisma, 's', [lag], notify, log);
    await syncAlerts(prisma, 's', [lag], notify, log);
    await syncAlerts(prisma, 's', [], notify, log);
    await syncAlerts(prisma, 's', [], notify, log);
    expect(notify.mock.calls.map((c) => c[0])).toEqual([
      ':rotating_light: ingest is behind',
      ':white_check_mark: resolved: ingest-lag on space `s`',
    ]);
  });

  it('repeats an event only after its cooldown', async () => {
    const notify = vi.fn(async (_text: string) => {});
    const spike = event('change-spike', 'many changes', 60);
    const t0 = new Date('2026-10-11T10:00:00Z');
    await syncAlerts(prisma, 's', [spike], notify, log, t0);
    await syncAlerts(
      prisma,
      's',
      [],
      notify,
      log,
      new Date(t0.getTime() + 10 * 60e3),
    );
    await syncAlerts(
      prisma,
      's',
      [spike],
      notify,
      log,
      new Date(t0.getTime() + 30 * 60e3),
    );
    await syncAlerts(
      prisma,
      's',
      [spike],
      notify,
      log,
      new Date(t0.getTime() + 61 * 60e3),
    );
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
