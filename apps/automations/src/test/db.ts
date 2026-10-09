import { randomBytes } from 'node:crypto';
import { encryptSecret } from '../crypto.js';
import type { Env } from '../env.js';
import { PrismaClient, type Space } from '../generated/prisma/index.js';

let shared: PrismaClient | undefined;

export function testPrisma(): PrismaClient {
  shared ??= new PrismaClient();
  return shared;
}

/** TRUNCATE skips the change log's append-only row trigger, by design. */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  if (list)
    await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export const SECRET_KEY = randomBytes(32);

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL!,
    QOMON_API_BASE: 'https://qomon.invalid',
    QOMON_RPS: 5,
    QOMON_WRITES_ALLOWED: true,
    MAX_WRITES_PER_RUN: 500,
    MAX_FAILED_SHARE: 0.2,
    MIN_WRITES_FOR_FAILED_SHARE: 10,
    VERIFY_TIMEOUT_SECONDS: 30,
    SPACE_SECRET_KEY: SECRET_KEY.toString('base64'),
    ...overrides,
  };
}

export async function makeSpace(
  prisma: PrismaClient,
  data: Partial<Space> = {},
): Promise<Space> {
  return prisma.space.create({
    data: {
      key: 'test-space',
      name: 'Test campaign',
      qomonApiKeyEncrypted: encryptSecret('sandbox-key', SECRET_KEY),
      writesEnabled: true,
      canvassedValues: ['present', 'absent', 'refus', 'repasse'],
      householdValue: 'Absent (household)',
      ...data,
    },
  });
}
