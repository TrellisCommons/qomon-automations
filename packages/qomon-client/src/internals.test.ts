import { describe, expect, it, vi } from 'vitest';
import { withBackoff } from './backoff.js';
import { RateLimiter } from './throttle.js';
import {
  QomonAuthError,
  QomonRateLimitError,
  QomonServerError,
} from './errors.js';
import { GuardedContactWriter, IncompleteContactError, mergeContact } from './contact-write.js';

describe('RateLimiter', () => {
  it('spaces calls to the configured rps', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter({
      rps: 5, // 200ms spacing
      concurrency: 1,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    for (let i = 0; i < 4; i += 1) {
      await limiter.schedule(async () => i);
    }
    expect(sleeps.filter((s) => s > 0)).toEqual([200, 200, 200]);
  });

  it('penalize pushes the next slot out', async () => {
    let clock = 1000;
    const sleeps: number[] = [];
    const limiter = new RateLimiter({
      rps: 100,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    limiter.penalize(5000);
    await limiter.schedule(async () => 1);
    expect(sleeps.some((s) => s >= 5000)).toBe(true);
  });
});

describe('withBackoff', () => {
  it('retries retryable errors then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const out = await withBackoff(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new QomonServerError('boom', { method: 'GET', path: '/x', attempt: calls });
        }
        return 'ok';
      },
      { retries: 5, baseMs: 10, maxMs: 100, sleep, random: () => 0.5 },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable errors', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls += 1;
          throw new QomonAuthError('nope', { method: 'GET', path: '/x', attempt: calls });
        },
        { retries: 5, baseMs: 10, maxMs: 100, sleep },
      ),
    ).rejects.toBeInstanceOf(QomonAuthError);
    expect(calls).toBe(1);
  });

  it('honours retryAfterMs on a rate-limit error', async () => {
    const delays: number[] = [];
    let calls = 0;
    await withBackoff(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new QomonRateLimitError(
            'slow down',
            { method: 'GET', path: '/x', attempt: 1 },
            9_000,
          );
        }
        return 'ok';
      },
      {
        retries: 3,
        baseMs: 10,
        maxMs: 100,
        random: () => 0,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(delays[0]).toBeGreaterThanOrEqual(9_000);
  });
});

describe('GuardedContactWriter', () => {
  const transport = {
    createContact: vi.fn(async (c: Record<string, unknown>) => ({ ...c, id: 42 })),
    replaceContact: vi.fn(async (id: number, c: Record<string, unknown>) => ({ ...c, id })),
    getContact: vi.fn(async (id: number) => ({ id })),
  };

  it('creates via the synchronous path and returns the id', async () => {
    const w = new GuardedContactWriter(transport);
    await expect(w.createContact({ firstname: 'A', surname: 'B' })).resolves.toEqual({
      id: 42,
    });
  });

  it('refuses a replace that is not field-complete', async () => {
    const w = new GuardedContactWriter(transport);
    await expect(w.replaceContact(1, { firstname: 'A' })).rejects.toBeInstanceOf(
      IncompleteContactError,
    );
  });

  it('allows a field-complete replace', async () => {
    const w = new GuardedContactWriter(transport);
    await expect(
      w.replaceContact(1, {
        firstname: 'A',
        surname: 'B',
        mail: 'a@b.co',
        address: { street: 'x' },
      }),
    ).resolves.toMatchObject({ id: 1 });
  });

  it('updates by writing back the whole current record with the changes merged in', async () => {
    const store = new Map<number, Record<string, unknown>>([
      [7, { id: 7, firstname: 'Ada', surname: 'Lovelace', phone: '555', address: { street: 'Old St', city: 'Guelph', lat: 1 } }],
    ]);
    const w = new GuardedContactWriter({
      createContact: async (c) => c,
      replaceContact: async (id, c) => {
        store.set(id, c);
        return c;
      },
      getContact: async (id) => structuredClone(store.get(id)!),
    });
    // no email on file: a plain replace would refuse this contact
    const updated = await w.updateContact(7, { surname: 'King', address: { street: 'New St' } });
    expect(updated).toEqual({
      id: 7,
      firstname: 'Ada',
      surname: 'King',
      phone: '555',
      address: { street: 'New St', city: 'Guelph', lat: 1 },
    });
  });
});

describe('mergeContact', () => {
  it('leaves the address alone when the changes do not name it, and never takes an id from the changes', () => {
    expect(mergeContact({ id: 1, firstname: 'A', address: { city: 'X' } }, { id: 99, firstname: 'B' }, 1)).toEqual({
      id: 1,
      firstname: 'B',
      address: { city: 'X' },
    });
  });
});
