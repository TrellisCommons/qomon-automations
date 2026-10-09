import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { PrismaClient } from './generated/prisma/index.js';

export class ReportInsideRepoError extends Error {
  constructor(path: string) {
    super(
      `refusing to write a report inside a git checkout (${path}); real data never enters the repo folder`,
    );
    this.name = 'ReportInsideRepoError';
  }
}

/** The nearest ancestor directory holding `.git`, if any. */
function gitRootAbove(path: string): string | null {
  let dir = dirname(resolve(path));
  for (;;) {
    if (existsSync(resolve(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A run's planned writes as CSV: Qomon contact ids, the triggering contact,
 *  and each write's outcome. For checking a dry run against the sheet. */
export async function writeRunReport(
  prisma: PrismaClient,
  runId: string,
  path: string,
): Promise<number> {
  const root = gitRootAbove(path);
  if (root && resolve(path).startsWith(root + sep))
    throw new ReportInsideRepoError(path);
  const writes = await prisma.plannedWrite.findMany({
    where: { runId },
    orderBy: { contactId: 'asc' },
  });
  const rows = [
    'contact_id,trigger_contact_id,value_after,status,detail',
    ...writes.map((w) =>
      [w.contactId, w.triggerContactId, w.valueAfter, w.status, w.detail ?? '']
        .map((v) =>
          /[",\n]/.test(String(v))
            ? `"${String(v).replace(/"/g, '""')}"`
            : String(v),
        )
        .join(','),
    ),
  ];
  await writeFile(path, rows.join('\n') + '\n', { mode: 0o600 });
  return writes.length;
}

interface StoredStats {
  planned?: number;
  applied?: number;
  verified?: number;
  failed?: number;
  skipped?: number;
  progress?: {
    done: number;
    total: number;
    perMinute: number;
    etaSeconds: number | null;
    updatedAt: string;
  };
}

/** Recent runs of a space, newest first, as text. A running run shows its
 *  last saved progress (saved after every batch of writes). */
export async function runStatus(
  prisma: PrismaClient,
  spaceKey: string,
  runId?: string,
): Promise<string> {
  const runs = await prisma.jobRun.findMany({
    where: { spaceKey, ...(runId ? { id: runId } : {}) },
    orderBy: { startedAt: 'desc' },
    take: runId ? 1 : 5,
  });
  if (runs.length === 0) return `no runs for space ${spaceKey}`;
  return runs
    .map((run) => {
      const s = (run.stats ?? {}) as StoredStats;
      const p = s.progress;
      const lines = [
        `${run.id}  ${run.kind.toLowerCase()}  ${run.status}  ${run.applying ? 'applying' : 'dry run'}  started ${run.startedAt.toISOString()}${run.finishedAt ? `  finished ${run.finishedAt.toISOString()}` : ''}`,
        `  planned ${s.planned ?? '?'}  applied ${s.applied ?? 0}  verified ${s.verified ?? 0}  failed ${s.failed ?? 0}  skipped ${s.skipped ?? 0}`,
      ];
      if (p) {
        const pct = p.total ? Math.floor((p.done / p.total) * 100) : 100;
        const eta =
          run.status === 'RUNNING' && p.etaSeconds !== null
            ? `  about ${Math.ceil(p.etaSeconds / 60)} min left`
            : '';
        lines.push(
          `  progress ${p.done}/${p.total} (${pct}%)  ${p.perMinute}/min${eta}  as of ${p.updatedAt}`,
        );
      }
      if (run.error) lines.push(`  error: ${run.error}`);
      return lines.join('\n');
    })
    .join('\n');
}
