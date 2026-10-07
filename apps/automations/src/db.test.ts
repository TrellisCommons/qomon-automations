import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './generated/prisma/index.js';

const prisma = new PrismaClient();

afterAll(() => prisma.$disconnect());

describe('database', () => {
  it('has migrations applied by the global setup', async () => {
    const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`;
    expect(rows[0]?.exists).toBe(true);
  });
});
