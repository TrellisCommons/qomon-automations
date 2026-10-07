import { execSync } from 'node:child_process';

/**
 * Runs once before the test suite: applies migrations to the database in
 * DATABASE_URL. In a cloud session that is the preinstalled Postgres 16
 * cluster; in CI it is the Postgres 17 service container.
 */
export default function setup(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required for @trellis/automations tests.\n' +
        'Export DATABASE_URL="postgresql://qomon:qomon@localhost:5432/qomon_automations".',
    );
  }
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: process.env,
  });
}
