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

| Command                | What it does                                                             |
| ---------------------- | ------------------------------------------------------------------------ |
| `npm run lint`         | ESLint, type-aware, reports without rewriting                            |
| `npm run format:check` | Prettier, verifies formatting and LF endings                             |
| `npm run typecheck`    | `tsc --noEmit` over sources and tests                                    |
| `npm run test:unit`    | Fast tier. Pure rules, state machine and mocked services. **No Docker.** |
| `npm run test:int`     | Slow tier. Real PostgreSQL via Testcontainers. **Docker required.**      |
| `npm run build`        | `nest build`                                                             |

The two test tiers are separate on purpose. Everything that is a claim about _rules_ is settled in
the fast tier with no database at all; everything that is a claim about _SQL_ — constraints,
isolation, locking — is settled in the slow tier against a real PostgreSQL, because those claims
are not testable against a mock.

## Roadmap

- [x] 01 — Scaffold & tooling
- [x] 02 — Config & bootstrap
- [x] 03 — Postgres, Prisma & the core models
- [x] 04 — Relations, constraints & seed
- [x] 05 — DB test harness (Testcontainers)
- [ ] 06 — Events: read endpoints
- [ ] 07 — Events: writes & the status state machine
- [ ] 08 — Problem Details & Prisma error mapping
- [ ] 09 — Paging, sorting, filtering, search
- [ ] 10 — Attendees
- [ ] 11 — Registration: rules engine & happy path
- [ ] 12 — Capacity under concurrency
- [ ] 13 — Waitlist & promotion
- [ ] 14 — Query performance: measure, then fix
- [ ] 15 — Guards, decorators, interceptors, throttling
- [ ] 16 — End-to-end tier
- [ ] 17 — OpenAPI, Swagger UI & health
- [ ] 18 — Ship

## Licence

UNLICENSED — portfolio project.
