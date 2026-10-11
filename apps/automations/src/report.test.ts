import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ReportInsideRepoError,
  shadowReport,
  writeRunReport,
} from './report.js';
import { makeSpace, resetDb, testPrisma } from './test/db.js';

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

describe('shadow report', () => {
  it("counts the full runs' writes an incremental run also planned, and lists the rest", async () => {
    await resetDb(prisma);
    await makeSpace(prisma);
    const run = (kind: 'HOURLY' | 'INCREMENTAL', startedAt: string) =>
      prisma.jobRun.create({
        data: {
          job: 'household-match',
          spaceKey: 'test-space',
          kind,
          applying: kind === 'HOURLY',
          startedAt: new Date(startedAt),
        },
      });
    const write = (
      runId: string,
      contactId: number,
      status: 'PLANNED' | 'VERIFIED',
    ) =>
      prisma.plannedWrite.create({
        data: {
          runId,
          contactId,
          field: 'presence',
          valueAfter: 'absent',
          triggerContactId: 1,
          reason: 'test',
          status,
        },
      });
    const full = await run('HOURLY', '2026-10-11T13:00:00Z');
    const before = await run('HOURLY', '2026-10-11T11:00:00Z');
    const inc = await run('INCREMENTAL', '2026-10-11T12:30:00Z');
    await write(full.id, 101, 'VERIFIED');
    await write(full.id, 102, 'VERIFIED');
    await write(before.id, 103, 'VERIFIED');
    await write(inc.id, 101, 'PLANNED');

    expect(
      await shadowReport(
        prisma,
        'test-space',
        new Date('2026-10-11T12:00:00Z'),
      ),
    ).toBe(
      'since 2026-10-11T12:00:00.000Z: full runs wrote 2 household values; incremental runs planned 1 of them\nmissed 1: 102',
    );
  });
});
