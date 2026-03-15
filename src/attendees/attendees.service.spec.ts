import { Test } from '@nestjs/testing';

import { ResourceNotFoundError } from '../common/errors/domain-error';
import type { Attendee, Registration } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AttendeesService } from './attendees.service';

const ID = '0195e3a0-0000-7000-8000-0000000000a1';

function anAttendeeRow(overrides: Partial<Attendee> = {}): Attendee {
  return {
    id: ID,
    email: 'ada@example.com',
    name: 'Ada Lindqvist',
    createdAt: new Date('2027-01-15T10:00:00.000Z'),
    updatedAt: new Date('2027-01-15T10:00:00.000Z'),
    ...overrides,
  };
}

function aRegistrationRow(overrides: Partial<Registration> = {}): Registration {
  return {
    id: '0195e3a0-0000-7000-8000-0000000000c1',
    eventId: '0195e3a0-0000-7000-8000-0000000000e1',
    attendeeId: ID,
    status: 'CONFIRMED',
    waitlistPosition: null,
    registeredAt: new Date('2027-02-01T09:00:00.000Z'),
    cancelledAt: null,
    updatedAt: new Date('2027-02-01T09:00:00.000Z'),
    ...overrides,
  };
}

describe('AttendeesService', () => {
  const create = jest.fn();
  const findUnique = jest.fn();
  const findFirst = jest.fn();
  const findMany = jest.fn();
  let service: AttendeesService;

  beforeEach(async () => {
    create.mockReset();
    findUnique.mockReset();
    findFirst.mockReset();
    findMany.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AttendeesService,
        {
          provide: PrismaService,
          useValue: {
            attendee: { create, findUnique, findFirst },
            registration: { findMany },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(AttendeesService);
  });

  describe('create', () => {
    it('writes the email and name it was given', async () => {
      create.mockResolvedValue(anAttendeeRow());

      await service.create({ email: 'ada@example.com', name: 'Ada Lindqvist' });

      expect(create).toHaveBeenCalledWith({
        data: { email: 'ada@example.com', name: 'Ada Lindqvist' },
      });
    });

    it('does not look the address up first', async () => {
      // A pre-flight existence check would be a check-then-act: two requests for
      // the same address both find it free and both insert. The unique index is
      // the authority, and skipping the lookup is a round trip cheaper as well
      // as correct under concurrency.
      create.mockResolvedValue(anAttendeeRow());

      await service.create({ email: 'ada@example.com', name: 'Ada' });

      expect(findUnique).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('lets a driver conflict propagate to the filter unchanged', async () => {
      // The filter already maps a unique violation to a 409 naming the field.
      // Catching and rewrapping it here would only lose the constraint name.
      const conflict = Object.assign(new Error('duplicate'), { code: 'P2002' });
      create.mockRejectedValue(conflict);

      await expect(service.create({ email: 'ada@example.com', name: 'Ada' })).rejects.toBe(
        conflict,
      );
    });

    it('returns a response DTO with ISO timestamps', async () => {
      create.mockResolvedValue(anAttendeeRow());

      const attendee = await service.create({ email: 'ada@example.com', name: 'Ada' });

      expect(attendee.createdAt).toBe('2027-01-15T10:00:00.000Z');
      expect(typeof attendee.updatedAt).toBe('string');
    });
  });

  describe('findOne', () => {
    it('returns the attendee', async () => {
      findUnique.mockResolvedValue(anAttendeeRow());

      await expect(service.findOne(ID)).resolves.toMatchObject({
        id: ID,
        email: 'ada@example.com',
      });
    });

    it('raises not-found rather than returning null', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.findOne(ID)).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  describe('findRegistrations', () => {
    it('checks the attendee exists before listing', async () => {
      // Otherwise an unknown id and a person who has registered for nothing
      // both answer with an empty list, and the caller cannot tell a typo from
      // a fact.
      findUnique.mockResolvedValue(null);

      await expect(service.findRegistrations(ID)).rejects.toBeInstanceOf(ResourceNotFoundError);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('lists them newest first with a deterministic tiebreak', async () => {
      findUnique.mockResolvedValue(anAttendeeRow());
      findMany.mockResolvedValue([aRegistrationRow()]);

      await service.findRegistrations(ID);

      expect(findMany).toHaveBeenCalledWith({
        where: { attendeeId: ID },
        orderBy: [{ registeredAt: 'desc' }, { id: 'asc' }],
      });
    });

    it('maps them to response DTOs', async () => {
      findUnique.mockResolvedValue(anAttendeeRow());
      findMany.mockResolvedValue([aRegistrationRow({ status: 'WAITLISTED', waitlistPosition: 2 })]);

      const [registration] = await service.findRegistrations(ID);

      expect(registration).toMatchObject({
        status: 'WAITLISTED',
        waitlistPosition: 2,
        registeredAt: '2027-02-01T09:00:00.000Z',
        cancelledAt: null,
      });
    });

    it('returns an empty list for someone who has registered for nothing', async () => {
      findUnique.mockResolvedValue(anAttendeeRow());
      findMany.mockResolvedValue([]);

      await expect(service.findRegistrations(ID)).resolves.toEqual([]);
    });
  });
});
