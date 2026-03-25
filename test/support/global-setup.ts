import { execFileSync } from 'node:child_process';

import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { POSTGRES_IMAGE, rememberContainer } from './container';

/**
 * One container for the whole run, migrated once.
 *
 * Per-file containers would be honest too, and roughly thirty times slower for
 * no extra confidence: the tests are isolated from each other by truncation,
 * not by owning separate servers.
 */
export default async function globalSetup(): Promise<void> {
  const startedAt = Date.now();

  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('events_test')
    .withUsername('events')
    .withPassword('events')
    .start();

  rememberContainer(container);

  const databaseUrl = container.getConnectionUri();
  // Read by every worker: Jest forks them after this returns, so they inherit
  // it. The test Prisma client reads the same variable.
  process.env.DATABASE_URL = databaseUrl;

  // The end-to-end tier boots the real AppModule, whose config validator
  // demands these. Set here rather than in a .env so the suite is
  // self-contained and cannot pick up a developer's real keys.
  process.env.API_KEYS ??= 'stockholm-tech:sk_test_stockholm,malmo-events:sk_test_malmo';
  process.env.NODE_ENV ??= 'test';

  // `migrate deploy`, never `db push`. Deploy replays the migration history
  // verbatim, which is the only way the partial index, the functional index and
  // the two CHECK constraints exist in the test database at all — db push
  // reconciles against schema.prisma and silently drops all four, and every
  // constraint test would then pass by not being tested.
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  console.log(
    `\n  postgres ready and migrated in ${String(Date.now() - startedAt)}ms ` +
      `(${container.getHost()}:${String(container.getPort())})`,
  );
}
