import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Development seed.
 *
 * Every date here is computed relative to the moment the seed runs. Literal
 * dates rot: a fixture written as "2026-09-01" is a future event today and a
 * past one soon after, so the listing endpoint's default filter quietly stops
 * returning it and the demo data looks broken for no reason anyone can see.
 */
const days = (n: number): Date => new Date(Date.now() + n * 24 * 60 * 60 * 1000);
const hours = (from: Date, n: number): Date => new Date(from.getTime() + n * 60 * 60 * 1000);

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is not set; refusing to seed.');
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('This seed deletes every row. It will not run against production.');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    // Idempotent: the seed is re-run constantly during development, and
    // upserting three tables' worth of relationships is far more code than
    // starting from empty. Order matters — registrations reference both others,
    // and attendees are protected by RESTRICT.
    await prisma.registration.deleteMany();
    await prisma.event.deleteMany();
    await prisma.attendee.deleteMany();

    const attendees = await Promise.all(
      [
        { email: 'ada@example.com', name: 'Ada Lindqvist' },
        { email: 'bo@example.com', name: 'Bo Hedström' },
        { email: 'cai@example.com', name: 'Cai Nordin' },
        { email: 'dev@example.com', name: 'Devi Ramachandran' },
        { email: 'eli@example.com', name: 'Eli Bergqvist' },
        { email: 'fay@example.com', name: 'Fay Öberg' },
      ].map((data) => prisma.attendee.create({ data })),
    );

    const nearlyFullStart = days(21);
    const nearlyFull = await prisma.event.create({
      data: {
        title: 'Distributed Systems in Practice',
        description:
          'A day on consensus, partial failure and the parts of a distributed system that only ' +
          'show up under load.',
        venue: 'Norra Latin, Stockholm',
        startsAt: nearlyFullStart,
        endsAt: hours(nearlyFullStart, 8),
        // Small on purpose: the waitlist and the capacity race are the point of
        // this project, and neither is visible on an event with 200 free seats.
        capacity: 3,
        waitlistEnabled: true,
        registrationClosesAt: days(20),
        status: 'PUBLISHED',
      },
    });

    const largeStart = days(35);
    const large = await prisma.event.create({
      data: {
        title: 'TypeScript at Scale',
        description: 'Type-level design, build performance, and living with a million-line repo.',
        venue: 'Clarion Sign, Stockholm',
        startsAt: largeStart,
        endsAt: hours(largeStart, 6),
        capacity: 100,
        waitlistEnabled: true,
        status: 'PUBLISHED',
      },
    });

    const draftStart = days(60);
    await prisma.event.create({
      data: {
        title: 'Postgres Internals Workshop',
        description: 'MVCC, the planner, and reading EXPLAIN without guessing.',
        venue: 'Malmö Live',
        startsAt: draftStart,
        endsAt: hours(draftStart, 7),
        capacity: 20,
        waitlistEnabled: false,
        status: 'DRAFT',
      },
    });

    const cancelledStart = days(10);
    await prisma.event.create({
      data: {
        title: 'Kubernetes Operators',
        venue: 'Chalmers Kårhus, Göteborg',
        startsAt: cancelledStart,
        endsAt: hours(cancelledStart, 4),
        capacity: 50,
        status: 'CANCELLED',
      },
    });

    // In the past, so the listing endpoint's date filters have something to
    // exclude and the "from"/"to" query parameters are demonstrable.
    const pastStart = days(-14);
    await prisma.event.create({
      data: {
        title: 'Observability Fundamentals',
        venue: 'Uppsala Konsert & Kongress',
        startsAt: pastStart,
        endsAt: hours(pastStart, 5),
        capacity: 40,
        status: 'PUBLISHED',
      },
    });

    // Fill the small event exactly to capacity, then two more onto the waitlist
    // in order. This is the state the waitlist endpoints are interesting in.
    const [ada, bo, cai, devi, eli, fay] = attendees;
    const confirmed = [ada, bo, cai];
    const waitlisted = [devi, eli];

    for (const attendee of confirmed) {
      await prisma.registration.create({
        data: { eventId: nearlyFull.id, attendeeId: attendee!.id, status: 'CONFIRMED' },
      });
    }

    for (const [index, attendee] of waitlisted.entries()) {
      await prisma.registration.create({
        data: {
          eventId: nearlyFull.id,
          attendeeId: attendee!.id,
          status: 'WAITLISTED',
          waitlistPosition: index + 1,
        },
      });
    }

    await prisma.registration.create({
      data: { eventId: large.id, attendeeId: ada!.id, status: 'CONFIRMED' },
    });

    // A cancelled registration, so the partial unique index has something real
    // to be doing: this pair may register again, and no other pair may double up.
    await prisma.registration.create({
      data: {
        eventId: large.id,
        attendeeId: fay!.id,
        status: 'CANCELLED',
        cancelledAt: new Date(),
      },
    });

    const [events, registrations] = await Promise.all([
      prisma.event.count(),
      prisma.registration.count(),
    ]);

    console.log(
      `seeded ${String(attendees.length)} attendees, ${String(events)} events, ` +
        `${String(registrations)} registrations`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
