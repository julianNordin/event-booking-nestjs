import { BadRequestException, NotFoundException } from '@nestjs/common';
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
  let service: EventsService;

  beforeEach(async () => {
    findMany.mockReset();
    findUnique.mockReset();
    create.mockReset();

    // The reason the DI container is here at all. PrismaService is replaced
    // wholesale by an object that answers the two calls this service makes, so
    // the service is exercised with no database, no adapter and no container —
    // and the substitution is a three-line override rather than a refactor.
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: { event: { findMany, findUnique, create } } },
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
});
