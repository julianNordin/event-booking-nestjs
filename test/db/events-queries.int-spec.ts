import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { EventsService } from '../../src/events/events.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createEvent } from '../support/factories';
import { testPrisma } from '../support/prisma';

const DAY = 24 * 60 * 60 * 1000;

/**
 * The same service the controller uses, over a real PostgreSQL.
 *
 * The unit tests already pin down what the service *asks* Prisma for. These
 * pin down what PostgreSQL actually *does* with those queries — ordering,
 * timestamp round-trips, the behaviour of a missing row — none of which a mock
 * can tell you anything about.
 */
describe('EventsService against a real database', () => {
  let service: EventsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // The real query path, bound to the shared container client so the suite
      // does not open a second connection pool per test file.
      providers: [EventsService, { provide: PrismaService, useValue: testPrisma() }],
    }).compile();

    service = moduleRef.get(EventsService);
  });

  describe('findAll', () => {
    it('returns nothing when there are no events', async () => {
      await expect(service.findAll()).resolves.toEqual([]);
    });

    it('returns the soonest event first', async () => {
      const later = await createEvent({
        title: 'later',
        startsAt: new Date(Date.now() + 30 * DAY),
      });
      const sooner = await createEvent({
        title: 'sooner',
        startsAt: new Date(Date.now() + 2 * DAY),
      });
      const middle = await createEvent({
        title: 'middle',
        startsAt: new Date(Date.now() + 10 * DAY),
      });

      const events = await service.findAll();

      expect(events.map((event) => event.id)).toEqual([sooner.id, middle.id, later.id]);
    });

    it('breaks ties on equal start times deterministically', async () => {
      // Three events at the same instant. Without the id tiebreak PostgreSQL is
      // free to return these in any order, and it will happily return a
      // different one once the table grows enough to change the plan.
      const startsAt = new Date(Date.now() + 5 * DAY);
      await Promise.all([
        createEvent({ startsAt }),
        createEvent({ startsAt }),
        createEvent({ startsAt }),
      ]);

      const first = (await service.findAll()).map((event) => event.id);
      const second = (await service.findAll()).map((event) => event.id);

      expect(first).toEqual(second);
      expect(first).toEqual([...first].sort());
    });

    it('includes events of every status', async () => {
      // Filtering by status is a later concern. Silently hiding drafts here
      // would make that phase look like it was already done.
      await createEvent({ status: 'DRAFT' });
      await createEvent({ status: 'PUBLISHED' });
      await createEvent({ status: 'CANCELLED' });

      const statuses = (await service.findAll()).map((event) => event.status).sort();

      expect(statuses).toEqual(['CANCELLED', 'DRAFT', 'PUBLISHED']);
    });
  });

  describe('findOne', () => {
    it('returns the event with its fields intact through the round trip', async () => {
      const startsAt = new Date('2027-10-31T02:30:00.000Z');
      const created = await createEvent({
        title: 'Postgres Internals',
        description: 'MVCC and the planner.',
        venue: 'Malmö Live',
        startsAt,
        capacity: 20,
        waitlistEnabled: false,
        status: 'DRAFT',
      });

      const found = await service.findOne(created.id);

      expect(found).toMatchObject({
        id: created.id,
        title: 'Postgres Internals',
        description: 'MVCC and the planner.',
        venue: 'Malmö Live',
        capacity: 20,
        waitlistEnabled: false,
        status: 'DRAFT',
        startsAt: startsAt.toISOString(),
      });
    });

    it('preserves a null description as null', async () => {
      const created = await createEvent({ description: null });

      await expect(service.findOne(created.id)).resolves.toMatchObject({ description: null });
    });

    it('raises not-found for a well-formed id that does not exist', async () => {
      await expect(service.findOne('0195e3a0-0000-7000-8000-0000deadbeef')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('does not leak another event when the id is absent', async () => {
      await createEvent();

      await expect(service.findOne('0195e3a0-0000-7000-8000-0000deadbeef')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
