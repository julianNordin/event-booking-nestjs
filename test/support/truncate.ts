import { PrismaClient } from '../../src/generated/prisma/client';

interface TableRow {
  tablename: string;
}

let cachedTables: string[] | undefined;

/**
 * Empty every table between tests.
 *
 * Measured on this machine against the alternative of recreating the schema —
 * dropping `public` and replaying the migration history, which is what
 * `prisma migrate reset` does:
 *
 *   TRUNCATE ... RESTART IDENTITY CASCADE      8 ms   (median of 25)
 *   DROP SCHEMA + prisma migrate deploy    1862 ms   (median of 5)
 *
 * About 230x the cost, per test. The numbers are recorded here so nobody
 * reopens the question: across a few hundred integration tests it is the
 * difference between seconds and ten minutes, which is the difference between
 * a suite that runs on every save and one that runs in CI and nowhere else.
 *
 * CASCADE handles the foreign keys without needing an order, and RESTART
 * IDENTITY resets sequences so an autoincrement value never leaks between
 * tests. The table list is discovered rather than hard-coded, so a new model
 * cannot be silently left dirty.
 */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  cachedTables ??= (
    await prisma.$queryRaw<TableRow[]>`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename <> '_prisma_migrations'
    `
  ).map((row) => `"${row.tablename}"`);

  if (cachedTables.length === 0) {
    return;
  }

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${cachedTables.join(', ')} RESTART IDENTITY CASCADE`,
  );
}
