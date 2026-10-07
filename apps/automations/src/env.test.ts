import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const base = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/db' };

describe('loadEnv', () => {
  it('leaves Qomon writes off unless explicitly allowed', () => {
    expect(loadEnv(base).QOMON_WRITES_ALLOWED).toBe(false);
    expect(
      loadEnv({ ...base, QOMON_WRITES_ALLOWED: 'false' }).QOMON_WRITES_ALLOWED,
    ).toBe(false);
    expect(
      loadEnv({ ...base, QOMON_WRITES_ALLOWED: 'true' }).QOMON_WRITES_ALLOWED,
    ).toBe(true);
  });

  it('rejects a writes flag that is not exactly true or false', () => {
    expect(() => loadEnv({ ...base, QOMON_WRITES_ALLOWED: 'yes' })).toThrow(
      /QOMON_WRITES_ALLOWED/,
    );
  });

  it('treats blank values as unset', () => {
    const env = loadEnv({ ...base, SLACK_BOT_TOKEN: '', HEALTHCHECK_URL: '' });
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(env.HEALTHCHECK_URL).toBeUndefined();
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});
