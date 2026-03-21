import { Test } from '@nestjs/testing';

import { MAX_PAGE_SIZE } from '../../src/common/dto/page-query.dto';
import { ValidationFailedError } from '../../src/common/errors/domain-error';
import { ListEventsQueryDto } from '../../src/events/dto/list-events-query.dto';
import { EventsService } from '../../src/events/events.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { WaitlistService } from '../../src/registrations/waitlist.service';
import { createEvent } from '../support/factories';
import { testPrisma } from '../support/prisma';

const DAY = 24 * 60 * 60 * 1000;

function query(overrides: Partial<ListEventsQueryDto> = {}): ListEventsQueryDto {
  return Object.assign(new ListEventsQueryDto(), overrides);
}

async function captureValidationFailure(
  operation: () => Promise<unknown>,
): Promise<ValidationFailedError> {
  try {
    await operation();
  } catch (error) {
    return error as ValidationFailedError;
  }
  throw new Error('expected the service to reject this query');
}

describe('listing events against a real database', () => {
  let service: EventsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        WaitlistService,
        { provide: PrismaService, useValue: testPrisma() },
      ],
    }).compile();

    service = moduleRef.get(EventsService);
  });

  /** `count` events, one day apart, starting tomorrow. */
  async function seedSequence(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await createEvent({
        title: `Event ${String(i).padStart(2, '0')}`,
        startsAt: new Date(Date.now() + (i + 1) * DAY),
      });
    }
  }

  describe('paging', () => {
    it('returns a full first page with the totals worked out', async () => {
      await seedSequence(25);

      const page = await service.findAll(query({ page: 1, size: 10 }));

      expect(page.items).toHaveLength(10);
      expect(page.totalItems).toBe(25);
      expect(page.totalPages).toBe(3);
      expect(page.hasPrevious).toBe(false);
      expect(page.hasNext).toBe(true);
    });

    it('returns a short last page', async () => {
      await seedSequence(25);

      const page = await service.findAll(query({ page: 3, size: 10 }));

      expect(page.items).toHaveLength(5);
      // The size reported is what was asked for, not what came back.
      expect(page.size).toBe(10);
      expect(page.hasNext).toBe(false);
      expect(page.hasPrevious).toBe(true);
    });

    it('returns an empty page past the end rather than failing', async () => {
      await seedSequence(5);

      const page = await service.findAll(query({ page: 99, size: 10 }));

      expect(page.items).toEqual([]);
      expect(page.totalItems).toBe(5);
    });

    it('clamps an enormous size to the maximum', async () => {
      await seedSequence(3);

      const page = await service.findAll(query({ page: 1, size: 100_000 }));

      expect(page.size).toBe(MAX_PAGE_SIZE);
      expect(page.items).toHaveLength(3);
    });

    it('walks every row exactly once across pages, with no duplicates and none missed', async () => {
      // Twelve events sharing one start time, paged three at a time. This
      // covers the paging arithmetic end to end: an off-by-one in skip or take
      // shows up here as a duplicate or a gap, which a single-page test cannot
      // see.
      //
      // It does *not* prove the id tiebreak is present, and it was checked
      // rather than assumed: removing the tiebreak leaves this test green,
      // because on a small unmodified table PostgreSQL happens to return equal
      // rows in heap order — which is insertion order, which for time-ordered
      // uuid v7 keys is already id order. The tiebreak's absence is caught in
      // the unit tier instead, where sort.spec.ts and events.service.spec.ts
      // assert the emitted ORDER BY directly and four tests go red without it.
      // Relying on PostgreSQL's incidental ordering to expose the bug would be
      // a test that passes for a reason unrelated to what it claims.
      const startsAt = new Date(Date.now() + 30 * DAY);
      for (let i = 0; i < 12; i += 1) {
        await createEvent({ startsAt, title: `Simultaneous ${String(i)}` });
      }

      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const result = await service.findAll(query({ page, size: 4 }));
        seen.push(...result.items.map((event) => event.id));
      }

      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
    });
  });

  describe('sorting', () => {
    it('defaults to soonest first', async () => {
      await seedSequence(3);

      const page = await service.findAll(query());

      expect(page.items.map((event) => event.title)).toEqual(['Event 00', 'Event 01', 'Event 02']);
    });

    it('sorts by a whitelisted field descending', async () => {
      await seedSequence(3);

      const page = await service.findAll(query({ sort: 'title,desc' }));

      expect(page.items.map((event) => event.title)).toEqual(['Event 02', 'Event 01', 'Event 00']);
    });

    it('sorts by capacity', async () => {
      await createEvent({ capacity: 30 });
      await createEvent({ capacity: 10 });
      await createEvent({ capacity: 20 });

      const page = await service.findAll(query({ sort: 'capacity' }));

      expect(page.items.map((event) => event.capacity)).toEqual([10, 20, 30]);
    });

    it('accepts sort=startsAt', async () => {
      await seedSequence(2);

      await expect(service.findAll(query({ sort: 'startsAt' }))).resolves.toBeDefined();
    });

    it('rejects sort=id and names the allowed fields', async () => {
      await seedSequence(2);

      const error = await captureValidationFailure(() => service.findAll(query({ sort: 'id' })));

      expect(error).toBeInstanceOf(ValidationFailedError);
      expect(error.errors[0]?.field).toBe('sort');
      expect(error.errors[0]?.message).toMatch(/startsAt/);
      expect(error.errors[0]?.message).toMatch(/capacity/);
    });
  });

  describe('filtering', () => {
    it('filters by status', async () => {
      await createEvent({ status: 'DRAFT' });
      await createEvent({ status: 'PUBLISHED' });
      await createEvent({ status: 'CANCELLED' });

      const page = await service.findAll(query({ status: 'PUBLISHED' }));

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.status).toBe('PUBLISHED');
      expect(page.totalItems).toBe(1);
    });

    it('matches a venue case-insensitively, as a substring', async () => {
      await createEvent({ venue: 'Norra Latin, Stockholm' });
      await createEvent({ venue: 'Malmö Live' });

      const page = await service.findAll(query({ venue: 'stockholm' }));

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.venue).toMatch(/Stockholm/);
    });

    it('filters from a date onwards', async () => {
      await seedSequence(5);

      const page = await service.findAll(query({ from: new Date(Date.now() + 3.5 * DAY) }));

      expect(page.items.map((event) => event.title)).toEqual(['Event 03', 'Event 04']);
    });

    it('filters up to a date', async () => {
      await seedSequence(5);

      const page = await service.findAll(query({ to: new Date(Date.now() + 2.5 * DAY) }));

      expect(page.items.map((event) => event.title)).toEqual(['Event 00', 'Event 01']);
    });

    it('filters within a closed range', async () => {
      await seedSequence(5);

      const page = await service.findAll(
        query({ from: new Date(Date.now() + 1.5 * DAY), to: new Date(Date.now() + 3.5 * DAY) }),
      );

      expect(page.items.map((event) => event.title)).toEqual(['Event 01', 'Event 02']);
    });
  });

  describe('search', () => {
    it('matches the title case-insensitively', async () => {
      await createEvent({ title: 'Postgres Internals Workshop' });
      await createEvent({ title: 'TypeScript at Scale' });

      const page = await service.findAll(query({ q: 'postgres' }));

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.title).toBe('Postgres Internals Workshop');
    });

    it('matches the description too', async () => {
      await createEvent({
        title: 'Unrelated Title',
        description: 'A day on MVCC and the planner.',
      });
      await createEvent({ title: 'Another', description: 'Nothing relevant.' });

      const page = await service.findAll(query({ q: 'mvcc' }));

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.title).toBe('Unrelated Title');
    });

    it('returns an event that matches on either field, not both', async () => {
      await createEvent({ title: 'Kubernetes Operators', description: null });

      await expect(service.findAll(query({ q: 'kubernetes' }))).resolves.toMatchObject({
        totalItems: 1,
      });
    });

    it('narrows when combined with another filter rather than widening', async () => {
      // The assertion that catches an OR written at the wrong level. Placed
      // outside the other conditions, this search would return the draft too.
      await createEvent({ title: 'Postgres Internals', status: 'PUBLISHED' });
      await createEvent({ title: 'Postgres Internals', status: 'DRAFT' });

      const page = await service.findAll(query({ q: 'postgres', status: 'PUBLISHED' }));

      expect(page.totalItems).toBe(1);
      expect(page.items[0]?.status).toBe('PUBLISHED');
    });

    it('finds nothing for a term that matches nothing', async () => {
      await createEvent({ title: 'Postgres Internals' });

      const page = await service.findAll(query({ q: 'kubernetes' }));

      expect(page.items).toEqual([]);
      expect(page.totalPages).toBe(0);
    });

    it('counts only the matches, not the whole table', async () => {
      // The count and the page share one where clause. If they ever drift, the
      // totals describe a different query than the items.
      await seedSequence(10);
      await createEvent({ title: 'Needle' });

      const page = await service.findAll(query({ q: 'needle', size: 5 }));

      expect(page.totalItems).toBe(1);
      expect(page.totalPages).toBe(1);
    });
  });
});
