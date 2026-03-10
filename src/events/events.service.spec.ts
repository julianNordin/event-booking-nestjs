import { NotFoundException } from '@nestjs/common';
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
  let service: EventsService;

  beforeEach(async () => {
    findMany.mockReset();
    findUnique.mockReset();

    // The reason the DI container is here at all. PrismaService is replaced
    // wholesale by an object that answers the two calls this service makes, so
    // the service is exercised with no database, no adapter and no container —
    // and the substitution is a three-line override rather than a refactor.
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: { event: { findMany, findUnique } } },
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
});
