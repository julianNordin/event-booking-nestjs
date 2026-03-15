import { Test } from '@nestjs/testing';

import { ATTENDEE_LIMITS } from '../../src/attendees/attendee-limits';
import { AttendeesService } from '../../src/attendees/attendees.service';
import { AlreadyExistsError, ResourceNotFoundError } from '../../src/common/errors/domain-error';
import { mapPrismaError } from '../../src/common/filters/prisma-error.mapper';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createAttendee, createEvent, createRegistration } from '../support/factories';
import { testPrisma } from '../support/prisma';

const prisma = testPrisma();

async function capture(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail');
}

describe('attendees against a real database', () => {
  let service: AttendeesService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [AttendeesService, { provide: PrismaService, useValue: testPrisma() }],
    }).compile();

    service = moduleRef.get(AttendeesService);
  });

  describe('the declared column widths', () => {
    it('match the limits the DTO validators enforce', async () => {
      const rows = await prisma.$queryRaw<{ column_name: string; max_length: number }[]>`
        SELECT column_name, character_maximum_length AS max_length
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'attendees'
          AND character_maximum_length IS NOT NULL
      `;

      const widths = Object.fromEntries(rows.map((row) => [row.column_name, row.max_length]));

      expect(widths.email).toBe(ATTENDEE_LIMITS.email);
      expect(widths.name).toBe(ATTENDEE_LIMITS.name);
    });
  });

  describe('create', () => {
    it('stores the attendee and returns it', async () => {
      const attendee = await service.create({ email: 'ada@example.com', name: 'Ada Lindqvist' });

      await expect(
        prisma.attendee.findUniqueOrThrow({ where: { id: attendee.id } }),
      ).resolves.toMatchObject({ email: 'ada@example.com', name: 'Ada Lindqvist' });
    });

    it('refuses a duplicate address', async () => {
      await service.create({ email: 'ada@example.com', name: 'Ada' });

      const raw = await capture(() => service.create({ email: 'ada@example.com', name: 'Ada 2' }));

      expect(mapPrismaError(raw)).toBeInstanceOf(AlreadyExistsError);
    });

    it('refuses an address that differs only in case', async () => {
      // The service never lower-cases anything — normalisation lives in the DTO
      // transform, which does not run when the service is called directly. This
      // is therefore the index doing the work on its own, which is exactly the
      // path a seed script or an internal caller would take.
      await service.create({ email: 'ada@example.com', name: 'Ada' });

      const raw = await capture(() => service.create({ email: 'ADA@EXAMPLE.COM', name: 'Ada 2' }));
      const mapped = mapPrismaError(raw);

      expect(mapped).toBeInstanceOf(AlreadyExistsError);
      expect(mapped?.status).toBe(409);
      expect(mapped?.extensions()).toEqual({ conflictingOn: 'email' });
    });

    it('accepts an address of exactly the declared width', async () => {
      const email = `${'a'.repeat(ATTENDEE_LIMITS.email - 'x@example.com'.length + 1)}@example.com`;

      expect(email).toHaveLength(ATTENDEE_LIMITS.email);
      await expect(service.create({ email, name: 'Long' })).resolves.toBeDefined();
    });
  });

  describe('findOne', () => {
    it('returns the stored attendee', async () => {
      const created = await createAttendee({ email: 'bo@example.com', name: 'Bo' });

      await expect(service.findOne(created.id)).resolves.toMatchObject({
        id: created.id,
        email: 'bo@example.com',
        name: 'Bo',
      });
    });

    it('raises not-found for an id that does not exist', async () => {
      await expect(service.findOne('0195e3a0-0000-7000-8000-0000deadbeef')).rejects.toBeInstanceOf(
        ResourceNotFoundError,
      );
    });
  });

  describe('findRegistrations', () => {
    it('returns nothing for someone who has registered for nothing', async () => {
      const attendee = await createAttendee();

      await expect(service.findRegistrations(attendee.id)).resolves.toEqual([]);
    });

    it('raises not-found rather than an empty list for an unknown attendee', async () => {
      await expect(
        service.findRegistrations('0195e3a0-0000-7000-8000-0000deadbeef'),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it('returns only that attendee’s registrations', async () => {
      const event = await createEvent();
      const [mine, theirs] = await Promise.all([createAttendee(), createAttendee()]);
      await createRegistration({ eventId: event.id, attendeeId: mine.id });
      await createRegistration({ eventId: event.id, attendeeId: theirs.id });

      const registrations = await service.findRegistrations(mine.id);

      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.attendeeId).toBe(mine.id);
    });

    it('includes cancelled registrations, which are the record of what happened', async () => {
      const event = await createEvent();
      const attendee = await createAttendee();
      await createRegistration({
        eventId: event.id,
        attendeeId: attendee.id,
        status: 'CANCELLED',
        cancelledAt: new Date(),
      });

      const registrations = await service.findRegistrations(attendee.id);

      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.status).toBe('CANCELLED');
      expect(registrations[0]?.cancelledAt).not.toBeNull();
    });

    it('lists across several events, newest registration first', async () => {
      const attendee = await createAttendee();
      const events = [await createEvent(), await createEvent(), await createEvent()];

      for (const event of events) {
        await createRegistration({ eventId: event.id, attendeeId: attendee.id });
      }

      const registrations = await service.findRegistrations(attendee.id);
      const times = registrations.map((registration) => registration.registeredAt);

      expect(registrations).toHaveLength(3);
      expect([...times]).toEqual([...times].sort().reverse());
    });
  });
});
