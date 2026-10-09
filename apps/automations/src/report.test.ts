import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ReportInsideRepoError, writeRunReport } from './report.js';
import { testPrisma } from './test/db.js';

const prisma = testPrisma();
afterAll(() => prisma.$disconnect());

describe('run report', () => {
  it('refuses a path inside a git checkout', async () => {
    await expect(
      writeRunReport(prisma, 'no-run', join(process.cwd(), 'report.csv')),
    ).rejects.toBeInstanceOf(ReportInsideRepoError);
  });

  it('writes a header-only CSV for a run with no writes', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'report-')), 'report.csv');
    expect(await writeRunReport(prisma, 'no-run', path)).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(
      'contact_id,trigger_contact_id,value_after,status,detail\n',
    );
  });
});
