import pg from 'pg';

/**
 * A Postgres session advisory lock on its own connection, so a manual run
 * cannot overlap the timer's. Prisma pools connections, which would let the
 * unlock land on a different session; a dedicated client also means a
 * crashed run releases the lock when its connection drops.
 */
export interface HeldLock {
  release(): Promise<void>;
}

export async function tryAdvisoryLock(
  databaseUrl: string,
  name: string,
): Promise<HeldLock | null> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [name],
    );
    if (!res.rows[0]?.locked) {
      await client.end();
      return null;
    }
  } catch (err) {
    await client.end();
    throw err;
  }
  return {
    async release() {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]);
      } finally {
        await client.end();
      }
    },
  };
}
