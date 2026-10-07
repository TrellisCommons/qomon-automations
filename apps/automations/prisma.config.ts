import { defineConfig } from 'prisma/config';

// Prisma skips its automatic .env loading when a prisma.config.ts exists, so
// load it here for local `prisma migrate dev`. Existing env vars win
// (loadEnvFile never overrides), and CI has no .env file, hence the guard.
try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env: rely on the ambient environment
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
});
