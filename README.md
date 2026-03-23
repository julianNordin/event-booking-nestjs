# event-booking-nestjs

A NestJS + Prisma + PostgreSQL API for events, attendees and registrations, built around one
problem that a CRUD demo cannot show: **two people racing for the last seat**.

Capacity is a check-then-act on shared state. Count the confirmed registrations, decide there is
room, insert — and under `READ COMMITTED` two concurrent requests both read the same count and
both insert. The event overbooks. That race, the test that proves it, and the row lock that closes
it are the substance of this repository; the rest is the scaffolding that makes it worth reading.

## Stack

|           |                                                                                         |
| --------- | --------------------------------------------------------------------------------------- |
| Runtime   | Node 24, TypeScript 5.9 (CommonJS)                                                      |
| Framework | NestJS 11 on Express                                                                    |
| ORM       | Prisma 7 — `prisma-client` generator, `@prisma/adapter-pg` driver adapter               |
| Database  | PostgreSQL 18                                                                           |
| Tests     | Jest, split into a `unit` tier and a Testcontainers-backed `int` tier                   |
| API       | REST under `/api/v1`, errors as RFC 9457 `application/problem+json`, OpenAPI at `/docs` |

## Quick start

```bash
npm ci
docker compose up -d db
npx prisma migrate deploy
npm run start:dev
```

Swagger UI at `/docs`, the raw spec at `/docs-json`, health at `/health`.

## Commands

| Command                  | What it does                                                              |
| ------------------------ | ------------------------------------------------------------------------- |
| `npm run lint`           | ESLint, type-aware, reports without rewriting                             |
| `npm run format:check`   | Prettier, verifies formatting and LF endings                              |
| `npm run typecheck`      | `tsc --noEmit` over sources and tests                                     |
| `npm run test:unit`      | Fast tier. Pure rules, state machine and mocked services. **No Docker.**  |
| `npm run test:int`       | Slow tier. Real PostgreSQL via Testcontainers. **Docker required.**       |
| `npm run build`          | `nest build`                                                              |
| `npm run check:overbook` | Fires 20 simultaneous registrations at a 1-seat event on a running server |

The two test tiers are separate on purpose. Everything that is a claim about _rules_ is settled in
the fast tier with no database at all; everything that is a claim about _SQL_ — constraints,
isolation, locking — is settled in the slow tier against a real PostgreSQL, because those claims
are not testable against a mock.

## Why a row lock

Capacity is the substance of this project, so the reasoning is written down rather than left in a
commit message.

### The race

Registering used to count the confirmed registrations, decide there was room, and insert. That is a
check-then-act on shared state. Under PostgreSQL's default `READ COMMITTED`, every concurrent
transaction sees the same count, every one finds room, and every one inserts.

Measured against this schema, not reasoned about:

| Implementation                      | 20 simultaneous requests, **1 seat** |
| ----------------------------------- | ------------------------------------ |
| count, then insert                  | **20 confirmed**                     |
| same, wrapped in a transaction      | **10 confirmed**                     |
| transaction + `SELECT … FOR UPDATE` | **1 confirmed**                      |

The middle row is the interesting one. Wrapping the check-then-act in a transaction fixes nothing —
`READ COMMITTED` is not `SERIALIZABLE`, and a transaction is not a mutex. Ten is simply the
connection pool size, which is how much concurrency actually reached the database. It is easy to
assume the transaction is what makes this correct; it is not, and the number says so.

### What the fix is

```sql
SELECT id FROM events WHERE id = $1 FOR UPDATE
```

taken inside the transaction and **before** the count. Every registration for that event queues
behind the one in front of it. Because the lock is on the event row, it serialises exactly the thing
that must be serialised and nothing else — a rush on one event does not delay another, and there is
a test that asserts it.

Prisma's client API cannot express this, so it is `$queryRaw` with the id as a bind parameter.

### Why not a denormalised counter

A `confirmed_count` column on `events`, incremented atomically, would also work — `UPDATE … SET
confirmed_count = confirmed_count + 1 WHERE id = $1 AND confirmed_count < capacity` takes a row lock
implicitly and is one statement.

It was rejected because it creates two sources of truth for the same fact. The counter and the rows
in `registrations` must agree forever, across every path that ever touches a registration: the
cancel endpoint, the waitlist promotion, the event-cancelled cascade, a future bulk import, a
support engineer fixing a row by hand. Every one of them has to remember. When they drift — and they
do — the drift is **silent**: the API reports a full event that has empty seats, or overbooks one
that looks full, and nothing anywhere raises an error. Recomputing from the rows, which is what this
service does, cannot drift because there is nothing to drift from.

The counter is the right answer when the count itself is too expensive to compute. Here it is an
index scan on `(event_id, status)`.

### Why not SERIALIZABLE with a retry loop

`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` makes the original count-then-insert correct: the
database detects the conflict and aborts one of the transactions with SQLSTATE `40001`.

It was rejected on operational grounds rather than correctness. Under contention — which is exactly
when this path matters — serialisation failures do not stay rare. Twenty people racing for one seat
produce nineteen aborts, and every one has to be retried by application code that must distinguish
`40001` from real failures, bound its attempts, and back off. That retry loop is more moving parts
than the lock, it turns a queue into a thundering herd, and its failure mode under load is a storm
of retries competing with the traffic that caused them.

`FOR UPDATE` makes contenders wait instead of fail. Waiting is the behaviour a queue for one seat
should have.

### Why not an application-level mutex

It would work on one process and silently stop working on two. The lock has to live where the shared
state lives.

## Query plans

Measured on 5,000 events and 50,000 registrations, with `EXPLAIN (ANALYZE, BUFFERS)`. Indexes were
added because a plan asked for one, not because a column looked like it wanted indexing.

| Query                                    | Plan                                                  | Time        |
| ---------------------------------------- | ----------------------------------------------------- | ----------- |
| List published events, soonest first     | Index Scan `events_status_starts_at_idx`              | 0.08 ms     |
| Registration counts for a page of events | Nested Loop over `ux_registration_active`             | 0.31 ms     |
| One event's waitlist, in ticket order    | Bitmap Index Scan `registrations_event_id_status_idx` | 0.03 ms     |
| One attendee's registrations             | Bitmap Index Scan `registrations_attendee_id_idx`     | 0.13 ms     |
| **Free-text search** (before)            | **Seq Scan**, 4,999 rows discarded                    | **5.55 ms** |
| **Free-text search** (after)             | Bitmap Index Scan `ix_events_title_trgm`              | **0.25 ms** |

Four of the five were already index-backed and well under a millisecond, so nothing was added for
them. Speculative indexes are not free: every one slows down every write and takes space, and one
added "just in case" is one nobody will ever dare remove.

### The one that needed help

Search is `ILIKE '%term%'`, and a btree cannot serve a leading wildcard — there is no prefix to seek
on. The fix is a trigram GIN index on each searchable column, which turns a full table scan into a
bitmap index scan, about twenty times faster here.

The extension it needs is created in the migration:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

The indexes themselves are declared in `schema.prisma`, not hand-written. Prisma does **not** notice
partial indexes, expression indexes or `CHECK` constraints, so those live only in migration SQL — but
it does recognise a plain-column GIN index, and `migrate diff` proposed a `DROP INDEX` for one it
could not see in the schema. Prisma can express this one, so it should.

### What the planner does with a bad search term

A search matching a quarter of the table still gets a sequential scan, even with the index in place.
That is correct, and worth stating because it looks like the index failing: walking 1,250 index
entries and then fetching 1,250 heap rows is slower than reading 112 pages in order. The index earns
its place on the selective searches people actually type.

### N+1

Listing events with their registration counts used to cost `2 + 2N` queries — two for the page and
its total, then two more per event. Measured with the Prisma client extension in
`src/prisma/query-counter.ts`:

| Page size | Before     | After     |
| --------- | ---------- | --------- |
| 5 events  | 12 queries | 3 queries |
| 10 events | 22 queries | 3 queries |

The test asserts that five events and ten cost the **same** number of queries, rather than asserting
a particular number. A magic number goes stale the first time somebody adds a legitimate query, and
it says nothing about whether the cost grows with the data — which is the only property that matters.

## Roadmap

- [x] 01 — Scaffold & tooling
- [x] 02 — Config & bootstrap
- [x] 03 — Postgres, Prisma & the core models
- [x] 04 — Relations, constraints & seed
- [x] 05 — DB test harness (Testcontainers)
- [x] 06 — Events: read endpoints
- [x] 07 — Events: writes & the status state machine
- [x] 08 — Problem Details & Prisma error mapping
- [x] 09 — Paging, sorting, filtering, search
- [x] 10 — Attendees
- [x] 11 — Registration: rules engine & happy path
- [x] 12 — Capacity under concurrency
- [x] 13 — Waitlist & promotion
- [x] 14 — Query performance: measure, then fix
- [x] 15 — Guards, decorators, interceptors, throttling
- [ ] 16 — End-to-end tier
- [ ] 17 — OpenAPI, Swagger UI & health
- [ ] 18 — Ship

## Licence

UNLICENSED — portfolio project.
