-- Written by hand: Prisma's schema language has no GIN index and no operator
-- classes, so neither of these can be expressed in schema.prisma.
--
-- Added because the query plans asked for it, and only this one did. Measured
-- on 5,000 events and 50,000 registrations, the listing, the grouped counts,
-- the waitlist and an attendee's own registrations were all index-backed and
-- under half a millisecond. Free-text search was the exception:
--
--   Seq Scan on events ... Rows Removed by Filter: 4999
--   Execution Time: 5.552 ms
--
-- A btree cannot help a leading-wildcard ILIKE — there is no prefix to seek on
-- — so the only options are a trigram index or a different kind of search
-- altogether. With these:
--
--   Bitmap Index Scan on ix_events_title_trgm
--   Execution Time: 0.250 ms
--
-- about twenty times faster on a selective term.
--
-- Note what the planner does with an *unselective* term: a search matching a
-- quarter of the table still gets a sequential scan, and that is correct. An
-- index is not free to walk, and 1,250 index hits followed by 1,250 heap
-- fetches is slower than reading 112 pages in order. The index earns its place
-- on the searches people actually type, not on every search.

-- Ships with PostgreSQL as a contrib module, but is not enabled by default.
-- On a managed database this may need to be granted rather than created.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "ix_events_title_trgm" ON "events" USING gin ("title" gin_trgm_ops);

-- Nullable, and GIN simply omits the null rows — which is what we want, since a
-- null description can never match a search term.
CREATE INDEX "ix_events_description_trgm" ON "events" USING gin ("description" gin_trgm_ops);
