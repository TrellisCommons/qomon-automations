import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { decryptSecret } from '../crypto.js';
import { resolveWriteMode } from '../qomon/write-mode.js';
import {
  SECRET_KEY,
  makeSpace,
  resetDb,
  testEnv,
  testPrisma,
} from '../test/db.js';
import {
  WritesNotAllowedError,
  redact,
  saveSpace,
  setWritesEnabled,
} from './spaces.js';

const prisma = testPrisma();
afterAll(() => prisma.$disconnect());
beforeEach(() => resetDb(prisma));

const config = {
  key: 'example',
  name: 'Example campaign',
  canvassedValues: ['present'],
  householdValue: 'Absent (household)',
};

describe('spaces', () => {
  it('stores the API key encrypted, starts with writes off, and change-logs it', async () => {
    const space = await saveSpace(
      prisma,
      SECRET_KEY,
      { ...config, qomonApiKey: 'sandbox-key' },
      'tester',
    );
    expect(space.writesEnabled).toBe(false);
    expect(space.qomonApiKeyEncrypted).not.toContain('sandbox-key');
    expect(decryptSecret(space.qomonApiKeyEncrypted, SECRET_KEY)).toBe(
      'sandbox-key',
    );
    const [entry] = await prisma.changeLogEntry.findMany();
    expect(JSON.stringify(entry)).not.toContain(space.qomonApiKeyEncrypted);
    expect(redact(space)).not.toHaveProperty('qomonApiKeyEncrypted');
  });

  it('updates settings without replacing the stored key', async () => {
    const first = await saveSpace(
      prisma,
      SECRET_KEY,
      { ...config, qomonApiKey: 'sandbox-key' },
      'tester',
    );
    const second = await saveSpace(
      prisma,
      SECRET_KEY,
      { ...config, municipality: 'Exampleton' },
      'tester',
    );
    expect(second.qomonApiKeyEncrypted).toBe(first.qomonApiKeyEncrypted);
    expect(second.municipality).toBe('Exampleton');
  });

  it('refuses to turn writes on where the environment does not allow them', async () => {
    await makeSpace(prisma, { writesEnabled: false });
    const env = testEnv({ QOMON_WRITES_ALLOWED: false });
    await expect(
      setWritesEnabled(prisma, env, 'test-space', true, {
        actor: 'tester',
        reason: 'try',
      }),
    ).rejects.toBeInstanceOf(WritesNotAllowedError);
    const off = await setWritesEnabled(prisma, env, 'test-space', false, {
      actor: 'tester',
      reason: 'stop',
    });
    expect(off.writesEnabled).toBe(false);
  });

  it('change-logs the space switch', async () => {
    await makeSpace(prisma, { writesEnabled: false });
    await setWritesEnabled(prisma, testEnv(), 'test-space', true, {
      actor: 'tester',
      reason: 'checked a sample',
    });
    const entry = await prisma.changeLogEntry.findFirstOrThrow({
      where: { subjectType: 'Space' },
    });
    expect(entry).toMatchObject({
      actor: 'tester',
      reason: 'checked a sample',
      before: { writesEnabled: false },
      after: { writesEnabled: true },
    });
  });

  it('the change log is append-only', async () => {
    await makeSpace(prisma, { writesEnabled: false });
    await setWritesEnabled(prisma, testEnv(), 'test-space', true, {
      actor: 'tester',
      reason: 'go',
    });
    await expect(
      prisma.changeLogEntry.updateMany({ data: { reason: 'edited' } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.changeLogEntry.deleteMany()).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('write guard', () => {
  it('writes only when the environment, the space, and the run all allow it', async () => {
    const space = await makeSpace(prisma);
    expect(resolveWriteMode(testEnv(), space, true)).toEqual({
      applying: true,
      blockedBy: [],
    });
    expect(
      resolveWriteMode(testEnv({ QOMON_WRITES_ALLOWED: false }), space, true)
        .applying,
    ).toBe(false);
    expect(
      resolveWriteMode(testEnv(), { ...space, writesEnabled: false }, true)
        .applying,
    ).toBe(false);
    expect(resolveWriteMode(testEnv(), space, false).blockedBy).toEqual([
      '--apply was not given',
    ]);
  });
});
