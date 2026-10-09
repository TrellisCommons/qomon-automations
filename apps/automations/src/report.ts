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
