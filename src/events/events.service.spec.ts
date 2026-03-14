import { MAX_PAGE_SIZE } from '../common/dto/page-query.dto';
import {
  ResourceNotFoundError,
  RuleViolationError,
  TransitionNotAllowedError,
  ValidationFailedError,
} from '../common/errors/domain-error';
import { Test } from '@nestjs/testing';

import type { Event } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from './events.service';

function anEventRow(overrides: Partial<Event> = {}): Event {
  return {
    id: '0195e3a0-0000-7000-8000-000000000001',
    title: 'Distributed Systems in Practice',
    description: null,
    venue: 'Norra Latin, Stockholm',
    startsAt: new Date('2027-03-29T09:00:00.000Z'),
    endsAt: new Date('2027-03-29T17:00:00.000Z'),
    capacity: 40,
    waitlistEnabled: true,
    registrationOpensAt: null,
    registrationClosesAt: null,
    status: 'PUBLISHED',
    createdAt: new Date('2027-01-15T10:00:00.000Z'),
    updatedAt: new Date('2027-01-15T10:00:00.000Z'),
    ...overrides,
  };
}

describe('EventsService', () => {
  const findMany = jest.fn();
  const findUnique = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const eventCount = jest.fn();
  const count = jest.fn();
  const deleteFn = jest.fn();
  const txEventUpdate = jest.fn();
  const txRegistrationUpdateMany = jest.fn();

  // $transaction has two forms and this service uses both. Given a callback it
  // hands over a client scoped to the transaction; given an array it runs the
  // operations together. Running the callback immediately against a stand-in
  // lets a test assert what happened *inside* the transaction rather than only
  // that one was opened.
  const $transaction = jest.fn(async (argument: unknown): Promise<unknown> =>
    Array.isArray(argument)
      ? Promise.all(argument as Promise<unknown>[])
      : (argument as (tx: unknown) => Promise<unknown>)({
          event: { update: txEventUpdate },
          registration: { updateMany: txRegistrationUpdateMany },
        }),
  );
  let service: EventsService;

  beforeEach(async () => {
    findMany.mockReset();
    findUnique.mockReset();
    create.mockReset();
    update.mockReset();
    eventCount.mockReset();
    count.mockReset();
    deleteFn.mockReset();
    txEventUpdate.mockReset();
    txRegistrationUpdateMany.mockReset();
    $transaction.mockClear();

    // The reason the DI container is here at all. PrismaService is replaced
    // wholesale by an object that answers the two calls this service makes, so
    // the service is exercised with no database, no adapter and no container —
    // and the substitution is a three-line override rather than a refactor.
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        {
          provide: PrismaService,
          useValue: {
            event: { findMany, findUnique, create, update, delete: deleteFn, count: eventCount },
            registration: { count },
            $transaction,
          },
        },
      ],
    }).compile();

    service = moduleRef.get(EventsService);
  });

  describe('findAll', () => {
    /** The argument findMany was given, typed rather than any. */
    function queried(): {
      where: Record<string, unknown>;
      orderBy: Record<string, string>[];
      skip: number;
      take: number;
    } {
      const calls = findMany.mock.calls as [
        {
          where: Record<string, unknown>;
          orderBy: Record<string, string>[];
          skip: number;
          take: number;
        },
      ][];
      const first = calls[0];
      if (first === undefined) throw new Error('expected findMany to have been called');
      return first[0];
    }

    it('returns response DTOs, not database rows', async () => {
      findMany.mockResolvedValue([anEventRow()]);
      eventCount.mockResolvedValue(1);

      const { items } = await service.findAll();

      // A Date here would mean a Prisma row escaped to the controller.
      expect(typeof items[0]?.startsAt).toBe('string');
      expect(items[0]?.startsAt).toBe('2027-03-29T09:00:00.000Z');
    });

    it('orders by start time with the id as a tiebreak by default', async () => {
      findMany.mockResolvedValue([]);
      eventCount.mockResolvedValue(0);

      await service.findAll();

      expect(queried().orderBy).toEqual([{ startsAt: 'asc' }, { id: 'asc' }]);
    });

    it('honours a whitelisted sort field and direction', async () => {
      findMany.mockResolvedValue([]);
      eventCount.mockResolvedValue(0);

      await service.findAll({ page: 1, size: 20, sort: 'title,desc' });

      expect(queried().orderBy).toEqual([{ title: 'desc' }, { id: 'asc' }]);
    });

    it('refuses a sort field that is not whitelisted, before querying', async () => {
      // Validated in the service rather than a pipe, so a caller arriving from
      // anywhere else is covered by the same rule.
      await expect(service.findAll({ page: 1, size: 20, sort: 'id' })).rejects.toBeInstanceOf(
        ValidationFailedError,
      );

      expect(findMany).not.toHaveBeenCalled();
    });

    it('clamps an enormous page size instead of refusing it', async () => {
      findMany.mockResolvedValue([]);
      eventCount.mockResolvedValue(0);

      const result = await service.findAll({ page: 1, size: 100_000 });

      expect(queried().take).toBe(MAX_PAGE_SIZE);
      expect(result.size).toBe(MAX_PAGE_SIZE);
    });

    it('translates the page number into a skip', async () => {
      findMany.mockResolvedValue([]);
      eventCount.mockResolvedValue(0);

      await service.findAll({ page: 3, size: 10 });

      expect(queried().skip).toBe(20);
      expect(queried().take).toBe(10);
    });

    it('counts and pages inside one transaction so the two agree', async () => {
      // Run separately, a write landing between them produces "showing 20 of 19".
      findMany.mockResolvedValue([]);
      eventCount.mockResolvedValue(0);

      await service.findAll();

      expect($transaction).toHaveBeenCalledTimes(1);
      const [[operations]] = $transaction.mock.calls as [[unknown]];
      expect(Array.isArray(operations)).toBe(true);
    });

    it('returns an empty page rather than failing when there are no events', async () => {
      findMany.mockResolvedValue([]);
      eventCount.mockResolvedValue(0);

      await expect(service.findAll()).resolves.toEqual({
        items: [],
        page: 1,
        size: 20,
        totalItems: 0,
        totalPages: 0,
        hasNext: false,
        hasPrevious: false,
      });
    });

    describe('filters', () => {
      beforeEach(() => {
        findMany.mockResolvedValue([]);
        eventCount.mockResolvedValue(0);
      });

      it('applies no filter at all when none is asked for', async () => {
        await service.findAll();

        expect(queried().where).toEqual({});
      });

      it('filters by exact status', async () => {
        await service.findAll({ page: 1, size: 20, status: 'PUBLISHED' });

        expect(queried().where).toEqual({ status: 'PUBLISHED' });
      });

      it('matches a venue case-insensitively as a substring', async () => {
        await service.findAll({ page: 1, size: 20, venue: 'stockholm' });

        expect(queried().where).toEqual({
          venue: { contains: 'stockholm', mode: 'insensitive' },
        });
      });

      it('builds a half-open range from either end alone', async () => {
        const from = new Date('2027-01-01T00:00:00.000Z');
        await service.findAll({ page: 1, size: 20, from });

        expect(queried().where).toEqual({ startsAt: { gte: from } });
      });

      it('builds a closed range from both ends', async () => {
        const from = new Date('2027-01-01T00:00:00.000Z');
        const to = new Date('2027-12-31T00:00:00.000Z');
        await service.findAll({ page: 1, size: 20, from, to });

        expect(queried().where).toEqual({ startsAt: { gte: from, lte: to } });
      });

      it('searches title and description together', async () => {
        await service.findAll({ page: 1, size: 20, q: 'postgres' });

        expect(queried().where).toEqual({
          OR: [
            { title: { contains: 'postgres', mode: 'insensitive' } },
            { description: { contains: 'postgres', mode: 'insensitive' } },
          ],
        });
      });

      it('ands the search with the other filters rather than widening them', async () => {
        // OR sits inside the top-level object, so a search combined with a
        // status must satisfy both. Placed wrong, ?q= returns every matching
        // event regardless of status.
        await service.findAll({ page: 1, size: 20, q: 'postgres', status: 'PUBLISHED' });

        expect(queried().where).toMatchObject({
          status: 'PUBLISHED',
          OR: expect.any(Array) as unknown[],
        });
      });
    });
  });

  describe('findOne', () => {
    it('looks the event up by its id', async () => {
      findUnique.mockResolvedValue(anEventRow());

      await service.findOne('0195e3a0-0000-7000-8000-000000000001');

      expect(findUnique).toHaveBeenCalledWith({
        where: { id: '0195e3a0-0000-7000-8000-000000000001' },
      });
    });

    it('maps the row it finds', async () => {
      findUnique.mockResolvedValue(anEventRow({ title: 'TypeScript at Scale' }));

      await expect(service.findOne('any')).resolves.toMatchObject({
        title: 'TypeScript at Scale',
        status: 'PUBLISHED',
      });
    });

    it('raises a not-found rather than returning null', async () => {
      // Returning null would push the decision onto every caller, and the first
      // one to forget answers 200 with an empty body.
      findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it('names the id it could not find', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.findOne('0195e3a0-dead')).rejects.toThrow(/0195e3a0-dead/);
    });
  });

  describe('create', () => {
    const validInput = {
      title: 'Distributed Systems in Practice',
      venue: 'Norra Latin, Stockholm',
      startsAt: new Date('2027-03-29T09:00:00.000Z'),
      endsAt: new Date('2027-03-29T17:00:00.000Z'),
      capacity: 40,
    };

    /** The `data` object the service handed to Prisma, typed rather than any. */
    function writtenData(): Record<string, unknown> {
      const calls = create.mock.calls as [{ data: Record<string, unknown> }][];
      const first = calls[0];
      if (first === undefined) {
        throw new Error('expected the service to have written something');
      }
      return first[0].data;
    }

    async function captureValidationFailure(
      operation: () => Promise<unknown>,
    ): Promise<ValidationFailedError> {
      try {
        await operation();
      } catch (error) {
        return error as ValidationFailedError;
      }
      throw new Error('expected the service to reject this input');
    }

    it('writes the fields it was given', async () => {
      create.mockResolvedValue(anEventRow());

      await service.create(validInput);

      expect(writtenData()).toMatchObject({
        title: 'Distributed Systems in Practice',
        venue: 'Norra Latin, Stockholm',
        capacity: 40,
        startsAt: validInput.startsAt,
        endsAt: validInput.endsAt,
      });
    });

    it('never sets a status', async () => {
      // The single most important assertion about create. An event that could
      // be born PUBLISHED has skipped the state machine entirely.
      create.mockResolvedValue(anEventRow());

      await service.create(validInput);

      expect(writtenData()).not.toHaveProperty('status');
    });

    it('defaults the waitlist to enabled and the optional times to null', async () => {
      // null rather than undefined: undefined tells Prisma "leave this alone",
      // which means something different on an update and is worth being
      // consistent about.
      create.mockResolvedValue(anEventRow());

      await service.create(validInput);

      expect(writtenData()).toMatchObject({
        waitlistEnabled: true,
        description: null,
        registrationOpensAt: null,
        registrationClosesAt: null,
      });
    });

    it('honours an explicitly disabled waitlist', async () => {
      create.mockResolvedValue(anEventRow());

      await service.create({ ...validInput, waitlistEnabled: false });

      expect(writtenData()).toMatchObject({ waitlistEnabled: false });
    });

    it('returns a response DTO rather than the row', async () => {
      create.mockResolvedValue(anEventRow());

      const created = await service.create(validInput);

      expect(typeof created.startsAt).toBe('string');
    });

    it('refuses an incoherent schedule before touching the database', async () => {
      // The CHECK constraint would catch this too, but only after a round trip,
      // and its error names a constraint rather than a field.
      await expect(
        service.create({ ...validInput, endsAt: validInput.startsAt }),
      ).rejects.toBeInstanceOf(ValidationFailedError);

      expect(create).not.toHaveBeenCalled();
    });

    it('names the offending field in the rejection', async () => {
      const error = await captureValidationFailure(() =>
        service.create({ ...validInput, endsAt: validInput.startsAt }),
      );

      expect(JSON.stringify(error.errors)).toMatch(/endsAt/);
    });

    it('reports every schedule problem at once', async () => {
      const error = await captureValidationFailure(() =>
        service.create({
          ...validInput,
          endsAt: validInput.startsAt,
          registrationClosesAt: new Date('2027-03-30T00:00:00.000Z'),
        }),
      );

      const body = JSON.stringify(error.errors);
      expect(body).toMatch(/endsAt/);
      expect(body).toMatch(/registrationClosesAt/);
    });
  });

  describe('update', () => {
    const id = '0195e3a0-0000-7000-8000-000000000001';

    function updatedData(): Record<string, unknown> {
      const calls = update.mock.calls as [{ data: Record<string, unknown> }][];
      const first = calls[0];
      if (first === undefined) {
        throw new Error('expected the service to have written something');
      }
      return first[0].data;
    }

    it('raises not-found when the event does not exist', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.update(id, { title: 'x' })).rejects.toBeInstanceOf(
        ResourceNotFoundError,
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses to edit a cancelled event', async () => {
      // Terminal in the state machine, terminal here: the row is the record of
      // something called off, and editing it rewrites what attendees were told.
      findUnique.mockResolvedValue(anEventRow({ status: 'CANCELLED' }));

      await expect(service.update(id, { title: 'x' })).rejects.toBeInstanceOf(
        TransitionNotAllowedError,
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('leaves absent fields untouched by passing undefined through', async () => {
      // Prisma reads undefined as "do not change this column", which is exactly
      // what an absent PATCH field means.
      findUnique.mockResolvedValue(anEventRow());
      update.mockResolvedValue(anEventRow({ title: 'renamed' }));

      await service.update(id, { title: 'renamed' });

      expect(updatedData().title).toBe('renamed');
      expect(updatedData().venue).toBeUndefined();
      expect(updatedData().capacity).toBeUndefined();
    });

    it('clears a field when the client sends null explicitly', async () => {
      findUnique.mockResolvedValue(anEventRow());
      update.mockResolvedValue(anEventRow());

      await service.update(id, { description: null });

      expect(updatedData().description).toBeNull();
    });

    describe('the schedule rules apply to the merged event', () => {
      it('checks a new endsAt against the stored startsAt', async () => {
        // The bug this prevents: patching one field at a time walks the event
        // into a state no single request would have been allowed to create.
        findUnique.mockResolvedValue(
          anEventRow({
            startsAt: new Date('2027-03-29T09:00:00.000Z'),
            endsAt: new Date('2027-03-29T17:00:00.000Z'),
          }),
        );

        await expect(
          service.update(id, { endsAt: new Date('2027-03-29T08:00:00.000Z') }),
        ).rejects.toBeInstanceOf(ValidationFailedError);

        expect(update).not.toHaveBeenCalled();
      });

      it('checks a new startsAt against the stored endsAt', async () => {
        findUnique.mockResolvedValue(
          anEventRow({
            startsAt: new Date('2027-03-29T09:00:00.000Z'),
            endsAt: new Date('2027-03-29T17:00:00.000Z'),
          }),
        );

        await expect(
          service.update(id, { startsAt: new Date('2027-03-29T18:00:00.000Z') }),
        ).rejects.toBeInstanceOf(ValidationFailedError);
      });

      it('accepts a coherent pair moved together', async () => {
        findUnique.mockResolvedValue(anEventRow());
        update.mockResolvedValue(anEventRow());

        await expect(
          service.update(id, {
            startsAt: new Date('2027-06-01T09:00:00.000Z'),
            endsAt: new Date('2027-06-01T17:00:00.000Z'),
          }),
        ).resolves.toBeDefined();
      });
    });

    describe('capacity', () => {
      it('may be raised without counting anything', async () => {
        findUnique.mockResolvedValue(anEventRow({ capacity: 40 }));
        update.mockResolvedValue(anEventRow({ capacity: 100 }));

        await service.update(id, { capacity: 100 });

        expect(count).not.toHaveBeenCalled();
        expect(updatedData().capacity).toBe(100);
      });

      it('may be lowered to exactly the confirmed count', async () => {
        findUnique.mockResolvedValue(anEventRow({ capacity: 40 }));
        count.mockResolvedValue(10);
        update.mockResolvedValue(anEventRow({ capacity: 10 }));

        await expect(service.update(id, { capacity: 10 })).resolves.toBeDefined();
      });

      it('may not be lowered below the confirmed count', async () => {
        // Otherwise the event is overbooked by construction, with no way to
        // decide which confirmed attendee loses their seat.
        findUnique.mockResolvedValue(anEventRow({ capacity: 40 }));
        count.mockResolvedValue(10);

        await expect(service.update(id, { capacity: 9 })).rejects.toBeInstanceOf(
          RuleViolationError,
        );
        expect(update).not.toHaveBeenCalled();
      });

      it('counts only confirmed seats, not waitlisted or cancelled ones', async () => {
        findUnique.mockResolvedValue(anEventRow({ capacity: 40 }));
        count.mockResolvedValue(0);
        update.mockResolvedValue(anEventRow());

        await service.update(id, { capacity: 1 });

        expect(count).toHaveBeenCalledWith({
          where: { eventId: id, status: 'CONFIRMED' },
        });
      });

      it('says how many seats are already taken', async () => {
        findUnique.mockResolvedValue(anEventRow({ capacity: 40 }));
        count.mockResolvedValue(12);

        await expect(service.update(id, { capacity: 5 })).rejects.toThrow(/12/);
      });
    });
  });

  describe('publish, cancel and delete', () => {
    const id = '0195e3a0-0000-7000-8000-000000000001';

    describe('publish', () => {
      it('moves a draft to published', async () => {
        findUnique.mockResolvedValue(anEventRow({ status: 'DRAFT' }));
        update.mockResolvedValue(anEventRow({ status: 'PUBLISHED' }));

        await expect(service.publish(id)).resolves.toMatchObject({ status: 'PUBLISHED' });
        expect(update).toHaveBeenCalledWith({ where: { id }, data: { status: 'PUBLISHED' } });
      });

      it('refuses to publish an already published event, with the reason', async () => {
        findUnique.mockResolvedValue(anEventRow({ status: 'PUBLISHED' }));

        await expect(service.publish(id)).rejects.toThrow(/already published/);
        expect(update).not.toHaveBeenCalled();
      });

      it('refuses to republish a cancelled event', async () => {
        findUnique.mockResolvedValue(anEventRow({ status: 'CANCELLED' }));

        await expect(service.publish(id)).rejects.toBeInstanceOf(TransitionNotAllowedError);
      });

      it('raises not-found before consulting the state machine', async () => {
        findUnique.mockResolvedValue(null);

        await expect(service.publish(id)).rejects.toBeInstanceOf(ResourceNotFoundError);
      });
    });

    describe('cancel', () => {
      it('cancels the event and its registrations in one transaction', async () => {
        // The two writes must land together. The event alone leaves rows
        // claiming confirmed seats at something that is not running; the
        // registrations alone loses the status if the second write fails.
        findUnique.mockResolvedValue(anEventRow({ status: 'PUBLISHED' }));
        txEventUpdate.mockResolvedValue(anEventRow({ status: 'CANCELLED' }));

        await expect(service.cancel(id)).resolves.toMatchObject({ status: 'CANCELLED' });

        expect($transaction).toHaveBeenCalledTimes(1);
        expect(txRegistrationUpdateMany).toHaveBeenCalledWith({
          where: { eventId: id, status: { in: ['CONFIRMED', 'WAITLISTED'] } },
          data: {
            status: 'CANCELLED',
            cancelledAt: expect.any(Date) as Date,
            waitlistPosition: null,
          },
        });
        expect(txEventUpdate).toHaveBeenCalledWith({
          where: { id },
          data: { status: 'CANCELLED' },
        });
      });

      it('leaves already-cancelled registrations alone', async () => {
        findUnique.mockResolvedValue(anEventRow({ status: 'PUBLISHED' }));
        txEventUpdate.mockResolvedValue(anEventRow({ status: 'CANCELLED' }));

        await service.cancel(id);

        const calls = txRegistrationUpdateMany.mock.calls as [
          { where: { status: { in: string[] } } },
        ][];
        expect(calls[0]?.[0].where.status.in).not.toContain('CANCELLED');
      });

      it('refuses to cancel a draft and says to delete it instead', async () => {
        findUnique.mockResolvedValue(anEventRow({ status: 'DRAFT' }));

        await expect(service.cancel(id)).rejects.toThrow(/delete/);
        expect($transaction).not.toHaveBeenCalled();
      });

      it('refuses to cancel twice', async () => {
        findUnique.mockResolvedValue(anEventRow({ status: 'CANCELLED' }));

        await expect(service.cancel(id)).rejects.toThrow(/already cancelled/);
      });
    });

    describe('remove', () => {
      it('deletes a draft', async () => {
        findUnique.mockResolvedValue(anEventRow({ status: 'DRAFT' }));
        deleteFn.mockResolvedValue(anEventRow());

        await service.remove(id);

        expect(deleteFn).toHaveBeenCalledWith({ where: { id } });
      });

      it('refuses to delete a published event and points at cancel', async () => {
        // Deleting would cascade its registrations away without a trace.
        findUnique.mockResolvedValue(anEventRow({ status: 'PUBLISHED' }));

        await expect(service.remove(id)).rejects.toThrow(/cancel/);
        expect(deleteFn).not.toHaveBeenCalled();
      });

      it('refuses to delete a cancelled event, which is kept as a record', async () => {
        findUnique.mockResolvedValue(anEventRow({ status: 'CANCELLED' }));

        await expect(service.remove(id)).rejects.toBeInstanceOf(TransitionNotAllowedError);
        expect(deleteFn).not.toHaveBeenCalled();
      });

      it('raises not-found for an event that is not there', async () => {
        findUnique.mockResolvedValue(null);

        await expect(service.remove(id)).rejects.toBeInstanceOf(ResourceNotFoundError);
      });
    });
  });
});
