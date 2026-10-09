import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';

/**
 * Every change the automation makes goes through `withChangeLog`, from
 * gpo/gpo-monolith's change-log write path: one database transaction, a
 * mandatory reason, and a ChangeLogEntry with the before and after values,
 * written in that same transaction. The table is append-only (a trigger
 * refuses UPDATE and DELETE).
 */

export class ChangeLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeLogError';
  }
}

export interface ActorContext {
  /** who made the change: a job name, or the person running the CLI */
  actor: string;
  /** mandatory human-readable reason */
  reason: string;
  /** reuse across a multi-step change; generated when absent */
  correlationId?: string;
}

export interface ChangeRecord {
  subjectType: 'QomonContact' | 'Space';
  subjectId: string;
  before?: unknown;
  after?: unknown;
  /** per-entry reason override; defaults to the actor's reason */
  reason?: string;
}

export interface ChangeLogContext {
  tx: Prisma.TransactionClient;
  correlationId: string;
  log(record: ChangeRecord): Promise<void>;
}

function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined
    ? Prisma.DbNull
    : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}

export async function withChangeLog<T>(
  prisma: PrismaClient,
  actor: ActorContext,
  fn: (ctx: ChangeLogContext) => Promise<T>,
): Promise<T> {
  if (!actor.reason || actor.reason.trim().length === 0) {
    throw new ChangeLogError('a change reason is mandatory');
  }
  const correlationId = actor.correlationId ?? randomUUID();

  return prisma.$transaction(async (tx) => {
    let wroteEntry = false;
    const result = await fn({
      tx,
      correlationId,
      async log(record) {
        wroteEntry = true;
        await tx.changeLogEntry.create({
          data: {
            subjectType: record.subjectType,
            subjectId: record.subjectId,
            actor: actor.actor,
            reason: record.reason ?? actor.reason,
            before: json(record.before),
            after: json(record.after),
            correlationId,
          },
        });
      },
    });
    if (!wroteEntry) {
      throw new ChangeLogError(
        'withChangeLog block completed without recording any ChangeLogEntry',
      );
    }
    return result;
  });
}
