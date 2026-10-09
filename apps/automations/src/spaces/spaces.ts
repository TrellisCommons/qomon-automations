import { QomonClient, type QomonApi } from '@trellis/qomon-client';
import { withChangeLog } from '../changelog/write.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type { Env } from '../env.js';
import type { PrismaClient, Space } from '../generated/prisma/index.js';

export class SpaceNotFoundError extends Error {
  constructor(key: string) {
    super(
      `no space with key ${JSON.stringify(key)}; add it with \`space:add\``,
    );
    this.name = 'SpaceNotFoundError';
  }
}

export class WritesNotAllowedError extends Error {
  constructor() {
    super(
      'Qomon writes are not allowed in this environment (QOMON_WRITES_ALLOWED is not true)',
    );
    this.name = 'WritesNotAllowedError';
  }
}

export async function getSpace(
  prisma: PrismaClient,
  key: string,
): Promise<Space> {
  const space = await prisma.space.findUnique({ where: { key } });
  if (!space) throw new SpaceNotFoundError(key);
  return space;
}

export function qomonFor(space: Space, env: Env, secretKey: Buffer): QomonApi {
  return new QomonClient({
    apiKey: decryptSecret(space.qomonApiKeyEncrypted, secretKey),
    baseUrl: space.qomonApiBase ?? env.QOMON_API_BASE,
  });
}

export interface SpaceConfig {
  key: string;
  name: string;
  qomonApiKey?: string;
  qomonApiBase?: string | null;
  activeUntil?: Date | null;
  municipality?: string | null;
  canvassedValues: string[];
  householdValue: string;
}

/** Without the API key, `config` is the key, name, and match settings only;
 *  the stored key is kept. Never touches `writesEnabled`. */
export async function saveSpace(
  prisma: PrismaClient,
  secretKey: Buffer,
  config: SpaceConfig,
  actor: string,
): Promise<Space> {
  const { qomonApiKey, ...settings } = config;
  return withChangeLog(
    prisma,
    { actor, reason: `configure space ${config.key}` },
    async (ctx) => {
      const before = await ctx.tx.space.findUnique({
        where: { key: config.key },
      });
      if (!before && !qomonApiKey)
        throw new Error('a new space needs its Qomon API key');
      const encrypted = qomonApiKey
        ? encryptSecret(qomonApiKey, secretKey)
        : undefined;
      const after = before
        ? await ctx.tx.space.update({
            where: { key: config.key },
            data: {
              ...settings,
              ...(encrypted ? { qomonApiKeyEncrypted: encrypted } : {}),
            },
          })
        : await ctx.tx.space.create({
            data: {
              ...settings,
              qomonApiKeyEncrypted: encrypted!,
              writesEnabled: false,
            },
          });
      await ctx.log({
        subjectType: 'Space',
        subjectId: config.key,
        before: before ? redact(before) : null,
        after: { ...redact(after), apiKeyChanged: Boolean(encrypted) },
      });
      return after;
    },
  );
}

/** The space switch. Turning it on is refused unless this environment
 *  allows writes; turning it off always works. */
export async function setWritesEnabled(
  prisma: PrismaClient,
  env: Env,
  key: string,
  enabled: boolean,
  actor: { actor: string; reason: string },
): Promise<Space> {
  if (enabled && !env.QOMON_WRITES_ALLOWED) throw new WritesNotAllowedError();
  return withChangeLog(prisma, actor, async (ctx) => {
    const before = await ctx.tx.space.findUnique({ where: { key } });
    if (!before) throw new SpaceNotFoundError(key);
    const after = await ctx.tx.space.update({
      where: { key },
      data: { writesEnabled: enabled },
    });
    await ctx.log({
      subjectType: 'Space',
      subjectId: key,
      before: { writesEnabled: before.writesEnabled },
      after: { writesEnabled: after.writesEnabled },
    });
    return after;
  });
}

export function redact(space: Space): Omit<Space, 'qomonApiKeyEncrypted'> {
  const { qomonApiKeyEncrypted: _secret, ...rest } = space;
  return rest;
}
