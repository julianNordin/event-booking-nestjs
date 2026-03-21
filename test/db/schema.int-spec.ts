import { testPrisma } from '../support/prisma';

interface NameRow {
  name: string;
}

describe('the migrated test schema', () => {
  const prisma = testPrisma();

  it('has replayed the full migration history', async () => {
    const rows = await prisma.$queryRaw<NameRow[]>`
      SELECT migration_name AS name
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL
      ORDER BY migration_name
    `;

    expect(rows.map((row) => row.name)).toEqual([
      '20260305174122_create_events_and_attendees',
      '20260307091447_create_registrations',
      '20260307094903_add_active_registration_and_email_indexes',
      '20260307095831_add_event_check_constraints',
      '20260321110639_add_trigram_search_indexes',
    ]);
  });

  it('carries the two indexes that only exist in hand-written SQL', async () => {
    // If the harness ever reached for `prisma db push` instead of
    // `migrate deploy`, these would be gone and every constraint test below
    // would pass by no longer testing anything. This is the tripwire for that.
    const rows = await prisma.$queryRaw<NameRow[]>`
      SELECT indexname AS name
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN ('ux_registration_active', 'ux_attendees_email_lower')
      ORDER BY indexname
    `;

    expect(rows.map((row) => row.name)).toEqual([
      'ux_attendees_email_lower',
      'ux_registration_active',
    ]);
  });

  it('carries both check constraints', async () => {
    const rows = await prisma.$queryRaw<NameRow[]>`
      SELECT conname AS name
      FROM pg_constraint
      WHERE conname IN ('ck_events_capacity', 'ck_events_ends_after')
      ORDER BY conname
    `;

    expect(rows.map((row) => row.name)).toEqual(['ck_events_capacity', 'ck_events_ends_after']);
  });

  it('carries the trigram indexes the search plans asked for', async () => {
    // Free-text search was the one query the plans showed doing a sequential
    // scan. These are what turn it into a bitmap index scan.
    const rows = await prisma.$queryRaw<NameRow[]>`
      SELECT indexname AS name
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN ('ix_events_title_trgm', 'ix_events_description_trgm')
      ORDER BY indexname
    `;

    expect(rows.map((row) => row.name)).toEqual([
      'ix_events_description_trgm',
      'ix_events_title_trgm',
    ]);
  });

  it('has the pg_trgm extension those indexes depend on', async () => {
    // Ships with PostgreSQL but is not enabled by default, so the migration
    // creates it. Without the extension the indexes cannot exist at all.
    const rows = await prisma.$queryRaw<NameRow[]>`
      SELECT extname AS name FROM pg_extension WHERE extname = 'pg_trgm'
    `;

    expect(rows).toHaveLength(1);
  });

  it('keeps the active-registration index partial rather than plain unique', async () => {
    // A plain unique index would also pass the existence check above while
    // making re-registration after a cancellation impossible, so the predicate
    // itself is asserted.
    const [row] = await prisma.$queryRaw<{ definition: string }[]>`
      SELECT indexdef AS definition
      FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = 'ux_registration_active'
    `;

    expect(row?.definition).toMatch(/WHERE \(status <> 'CANCELLED'/);
  });

  it('stores timestamps with a time zone, not without', async () => {
    // Prisma's default mapping for DateTime is timestamp(3) *without* a time
    // zone. Every timestamp in this schema pins @db.Timestamptz(3) instead, and
    // this is the assertion that none of them lost it.
    const rows = await prisma.$queryRaw<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (column_name LIKE '%_at' OR column_name LIKE '%At')
      ORDER BY table_name, column_name
    `;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_type).toBe('timestamp with time zone');
    }
  });
});
