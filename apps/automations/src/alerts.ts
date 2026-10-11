import type { PrismaClient } from './generated/prisma/index.js';
import type { Logger } from './log.js';

/**
 * Slack alerts that post once per problem.
 *
 * A **condition** (lag, quarantine, writes turned off) posts when it starts
 * and once more when it clears; while it holds, nothing is posted. An
 * **event** (a spike, 429s, a tripped breaker) posts when it happens, then
 * stays quiet for its cooldown even if it happens again.
 */
export interface Alert {
  key: string;
  text: string;
  kind: 'condition' | 'event';
  /** events only; default 6 hours */
  cooldownMinutes?: number;
}

export async function syncAlerts(
  prisma: PrismaClient,
  spaceKey: string,
  current: Alert[],
  notify: (text: string) => Promise<void>,
  log: Logger,
  now: Date = new Date(),
  /** conditions this run could not evaluate; their state is left as it is */
  unevaluated: string[] = [],
): Promise<void> {
  const posted = new Map(
    (await prisma.alertState.findMany({ where: { spaceKey } })).map((a) => [
      a.alertKey,
      a,
    ]),
  );
  for (const key of unevaluated) posted.delete(`condition:${key}`);
  // State changes only once Slack has the message, so a failed post is
  // retried on the next run instead of being recorded as sent.
  const send = async (text: string): Promise<boolean> => {
    try {
      await notify(text);
      return true;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Slack alert failed',
      );
      return false;
    }
  };

  for (const alert of current) {
    const before = posted.get(alert.key);
    posted.delete(alert.key);
    if (alert.kind === 'condition') {
      if (before) continue;
    } else if (before) {
      const cooldown = (alert.cooldownMinutes ?? 360) * 60_000;
      if (now.getTime() - before.raisedAt.getTime() < cooldown) continue;
    }
    if (!(await send(`:rotating_light: ${alert.text}`))) continue;
    await prisma.alertState.upsert({
      where: { spaceKey_alertKey: { spaceKey, alertKey: alert.key } },
      create: { spaceKey, alertKey: alert.key, raisedAt: now },
      update: { raisedAt: now },
    });
  }

  // Conditions no longer present have cleared. Events keep their row until
  // the cooldown passes, so a repeat inside it stays quiet.
  for (const [key, state] of posted) {
    if (key.startsWith('event:')) {
      if (now.getTime() - state.raisedAt.getTime() >= 24 * 60 * 60_000) {
        await prisma.alertState.delete({
          where: { spaceKey_alertKey: { spaceKey, alertKey: key } },
        });
      }
      continue;
    }
    const sent = await send(
      `:white_check_mark: resolved: ${key.replace(/^condition:/, '')} on space \`${spaceKey}\``,
    );
    if (!sent) continue;
    await prisma.alertState.delete({
      where: { spaceKey_alertKey: { spaceKey, alertKey: key } },
    });
  }
}

export const condition = (key: string, text: string): Alert => ({
  key: `condition:${key}`,
  text,
  kind: 'condition',
});

export const event = (
  key: string,
  text: string,
  cooldownMinutes?: number,
): Alert => ({
  key: `event:${key}`,
  text,
  kind: 'event',
  cooldownMinutes,
});
