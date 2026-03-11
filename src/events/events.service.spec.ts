import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
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
  const count = jest.fn();
  let service: EventsService;

  beforeEach(async () => {
    findMany.mockReset();
    findUnique.mockReset();
    create.mockReset();
    update.mockReset();
    count.mockReset();

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
            event: { findMany, findUnique, create, update },
            registration: { count },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(EventsService);
  });

  describe('findAll', () => {
    it('returns response DTOs, not database rows', async () => {
      findMany.mockResolvedValue([anEventRow()]);

      const [event] = await service.findAll();

      // A Date here would mean a Prisma row escaped to the controller.
      expect(typeof event?.startsAt).toBe('string');
      expect(event?.startsAt).toBe('2027-03-29T09:00:00.000Z');
    });

    it('orders by start time with the id as a tiebreak', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll();

      expect(findMany).toHaveBeenCalledWith({
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      });
    });

    it('returns an empty list rather than failing when there are no events', async () => {
      findMany.mockResolvedValue([]);

      await expect(service.findAll()).resolves.toEqual([]);
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

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
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

    async function captureBadRequest(
      operation: () => Promise<unknown>,
    ): Promise<BadRequestException> {
      try {
        await operation();
      } catch (error) {
        return error as BadRequestException;
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
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(create).not.toHaveBeenCalled();
    });

    it('names the offending field in the rejection', async () => {
      const error = await captureBadRequest(() =>
        service.create({ ...validInput, endsAt: validInput.startsAt }),
      );

      expect(JSON.stringify(error.getResponse())).toMatch(/endsAt/);
    });

    it('reports every schedule problem at once', async () => {
      const error = await captureBadRequest(() =>
        service.create({
          ...validInput,
          endsAt: validInput.startsAt,
          registrationClosesAt: new Date('2027-03-30T00:00:00.000Z'),
        }),
      );

      const body = JSON.stringify(error.getResponse());
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

      await expect(service.update(id, { title: 'x' })).rejects.toBeInstanceOf(NotFoundException);
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses to edit a cancelled event', async () => {
      // Terminal in the state machine, terminal here: the row is the record of
      // something called off, and editing it rewrites what attendees were told.
      findUnique.mockResolvedValue(anEventRow({ status: 'CANCELLED' }));

      await expect(service.update(id, { title: 'x' })).rejects.toBeInstanceOf(ConflictException);
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
        ).rejects.toBeInstanceOf(BadRequestException);

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
        ).rejects.toBeInstanceOf(BadRequestException);
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

        await expect(service.update(id, { capacity: 9 })).rejects.toBeInstanceOf(ConflictException);
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
});
