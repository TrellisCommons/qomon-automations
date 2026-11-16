import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ReportInsideRepoError,
  reviewList,
  runStatus,
  writeRunReport,
} from './report.js';
import { makeSpace, resetDb, testPrisma } from './test/db.js';

const prisma = testPrisma();
afterAll(() => prisma.$disconnect());

beforeEach(() => resetDb(prisma));

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'report-')), 'report.csv');
}

async function makeRun() {
  const space = await makeSpace(prisma);
  return prisma.jobRun.create({
    data: {
      job: 'contact-rules',
      spaceKey: space.key,
      kind: 'HOURLY',
      applying: false,
    },
  });
}

describe('run report', () => {
  it('refuses a path inside a git checkout', async () => {
    // the directory does not exist, so a missing guard cannot leave a file
    await expect(
      writeRunReport(
        prisma,
        'no-run',
        join(process.cwd(), 'no-such-dir', 'report.csv'),
      ),
    ).rejects.toBeInstanceOf(ReportInsideRepoError);
  });

  it('writes a header-only CSV for a run with no writes', async () => {
    const path = tempPath();
    expect(await writeRunReport(prisma, 'no-run', path)).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(
      'contact_id,field,trigger_contact_id,value_after,status,detail\n',
    );
  });

  it('quotes values holding commas or quotes, readable only by its owner', async () => {
    const run = await makeRun();
    await prisma.plannedWrite.create({
      data: {
        runId: run.id,
        contactId: 1,
        field: 'presence',
        valueAfter: 'absent',
        triggerContactId: 2,
        reason: 'household of contact 2',
        status: 'SKIPPED',
        detail: 'already "Do not contact", skipped',
      },
    });
    const path = tempPath();
    expect(await writeRunReport(prisma, run.id, path)).toBe(1);
    expect(readFileSync(path, 'utf8').split('\n')[1]).toBe(
      '1,presence,2,absent,SKIPPED,"already ""Do not contact"", skipped"',
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('run status', () => {
  it('shows only the run asked for', async () => {
    const first = await makeRun();
    const second = await prisma.jobRun.create({
      data: {
        job: 'contact-rules',
        spaceKey: 'test-space',
        kind: 'BACKFILL',
        applying: false,
      },
    });
    const text = await runStatus(prisma, 'test-space', first.id);
    expect(text).toContain(first.id);
    expect(text).not.toContain(second.id);
  });
});

describe('review list', () => {
  it('lists the contacts awaiting a decision, whether or not Slack listed them', async () => {
    const run = await makeRun();
    const row = (
      contactId: number,
      handling: 'REVIEW' | 'WRITTEN',
      notified: boolean,
    ) => ({
      spaceKey: run.spaceKey,
      contactId,
      handling,
      runId: run.id,
      reviewNotifiedAt: notified ? new Date('2026-10-10T12:00:00Z') : null,
    });
    await prisma.handledDeceased.createMany({
      data: [
        row(3, 'REVIEW', true),
        row(1, 'REVIEW', false),
        row(2, 'WRITTEN', false),
      ],
    });

    expect(await reviewList(prisma, run.spaceKey)).toBe(
      [
        '2 contacts no longer marked deceased but still "Do not contact":',
        '1',
        '3',
      ].join('\n'),
    );
  });

  it('says so when none are waiting', async () => {
    await makeSpace(prisma);
    expect(await reviewList(prisma, 'test-space')).toBe(
      'no contacts awaiting review on space test-space',
    );
  });
});
