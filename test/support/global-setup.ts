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
  // demands these. Assigned, never defaulted: the suite has to be self-contained,
  // and a `??=` here would hand control of it to whatever the surrounding
  // environment happens to set. CI sets its own API_KEYS, which under `??=` left
  // the journey suites signing every request with a key the app had never heard
  // of — 401 on CI, green on any machine with the variable unset.
  process.env.API_KEYS = 'stockholm-tech:sk_test_stockholm,malmo-events:sk_test_malmo';
  process.env.NODE_ENV ??= 'test';

  // The throttler is still installed and still running in the end-to-end tier —
  // this raises its limit, it does not remove it. A journey suite makes dozens
  // of calls from one address in a few seconds, which is exactly the traffic
  // the production limit exists to refuse. The limit itself is proved in
  // src/common/guards/throttling.spec.ts, which sets a low one deliberately.
  process.env.THROTTLE_LIMIT = '10000';

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
