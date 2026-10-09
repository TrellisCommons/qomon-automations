import { PrismaClient } from './generated/prisma/index.js';

let singleton: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  singleton ??= new PrismaClient();
  return singleton;
}

export type { PrismaClient };
