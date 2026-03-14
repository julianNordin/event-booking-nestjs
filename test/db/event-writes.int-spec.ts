import {
  RuleViolationError,
  TransitionNotAllowedError,
} from '../../src/common/errors/domain-error';
import { Test } from '@nestjs/testing';

import { EVENT_LIMITS } from '../../src/events/event-limits';
import { EventsService } from '../../src/events/events.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createAttendee, createEvent, createRegistration, fillEvent } from '../support/factories';
import { testPrisma } from '../support/prisma';

const prisma = testPrisma();

describe('event writes against a real database', () => {
  let service: EventsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [EventsService, { provide: PrismaService, useValue: testPrisma() }],
    }).compile();

    service = moduleRef.get(EventsService);
  });

  describe('the declared column widths', () => {
    it('match the limits the DTO validators enforce', async () => {
      // The two halves of one contract, checked against each other. Widening a
      // column without the validator gives a 400 for a value the database would
      // have taken; widening the validator without the column turns a clear 400
      // into a driver error at insert time. Neither is visible from one file.
      const rows = await prisma.$queryRaw<{ column_name: string; max_length: number }[]>`
        SELECT column_name, character_maximum_length AS max_length
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'events'
          AND character_maximum_length IS NOT NULL
      `;

      const widths = Object.fromEntries(rows.map((row) => [row.column_name, row.max_length]));

      expect(widths.title).toBe(EVENT_LIMITS.title);
      expect(widths.description).toBe(EVENT_LIMITS.description);
      expect(widths.venue).toBe(EVENT_LIMITS.venue);
    });

    it('accept a value of exactly the declared width', async () => {
      const event = await createEvent({ title: 'x'.repeat(EVENT_LIMITS.title) });

      expect(event.title).toHaveLength(EVENT_LIMITS.title);
    });
  });

  describe('publish', () => {
    it('moves a draft to published', async () => {
      const draft = await createEvent({ status: 'DRAFT' });

      await expect(service.publish(draft.id)).resolves.toMatchObject({ status: 'PUBLISHED' });

      const stored = await prisma.event.findUniqueOrThrow({ where: { id: draft.id } });
      expect(stored.status).toBe('PUBLISHED');
    });
  });

  describe('cancel', () => {
    it('cancels every active registration along with the event', async () => {
      const event = await createEvent({ capacity: 5, status: 'PUBLISHED' });
      await fillEvent(event.id, 3);

      const waitlisted = await createAttendee();
      await createRegistration({
        eventId: event.id,
        attendeeId: waitlisted.id,
        status: 'WAITLISTED',
        waitlistPosition: 1,
      });

      await service.cancel(event.id);

      const registrations = await prisma.registration.findMany({ where: { eventId: event.id } });

      expect(registrations).toHaveLength(4);
      expect(registrations.every((r) => r.status === 'CANCELLED')).toBe(true);
      expect(registrations.every((r) => r.cancelledAt !== null)).toBe(true);
      expect(registrations.every((r) => r.waitlistPosition === null)).toBe(true);
    });

    it('leaves the original timestamp on an already-cancelled registration', async () => {
      const event = await createEvent({ status: 'PUBLISHED' });
      const attendee = await createAttendee();
      const earlier = new Date('2027-01-01T00:00:00.000Z');
      const registration = await createRegistration({
        eventId: event.id,
        attendeeId: attendee.id,
        status: 'CANCELLED',
        cancelledAt: earlier,
      });

      await service.cancel(event.id);

      const stored = await prisma.registration.findUniqueOrThrow({
        where: { id: registration.id },
      });
      expect(stored.cancelledAt?.toISOString()).toBe(earlier.toISOString());
    });

    it('does not touch registrations belonging to another event', async () => {
      const [doomed, other] = await Promise.all([
        createEvent({ status: 'PUBLISHED' }),
        createEvent({ status: 'PUBLISHED' }),
      ]);
      await fillEvent(doomed.id, 2);
      await fillEvent(other.id, 2);

      await service.cancel(doomed.id);

      const survivors = await prisma.registration.findMany({ where: { eventId: other.id } });
      expect(survivors.every((r) => r.status === 'CONFIRMED')).toBe(true);
    });
  });

  describe('remove', () => {
    it('deletes a draft', async () => {
      const draft = await createEvent({ status: 'DRAFT' });

      await service.remove(draft.id);

      await expect(prisma.event.count()).resolves.toBe(0);
    });

    it('refuses to delete a published event, leaving it and its roster intact', async () => {
      const event = await createEvent({ status: 'PUBLISHED' });
      await fillEvent(event.id, 2);

      await expect(service.remove(event.id)).rejects.toBeInstanceOf(TransitionNotAllowedError);

      await expect(prisma.event.count()).resolves.toBe(1);
      await expect(prisma.registration.count()).resolves.toBe(2);
    });
  });

  describe('capacity', () => {
    it('cannot be reduced below the number of confirmed seats', async () => {
      const event = await createEvent({ capacity: 10 });
      await fillEvent(event.id, 4);

      await expect(service.update(event.id, { capacity: 3 })).rejects.toBeInstanceOf(
        RuleViolationError,
      );

      const stored = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(stored.capacity).toBe(10);
    });

    it('can be reduced to exactly the number of confirmed seats', async () => {
      const event = await createEvent({ capacity: 10 });
      await fillEvent(event.id, 4);

      await expect(service.update(event.id, { capacity: 4 })).resolves.toMatchObject({
        capacity: 4,
      });
    });

    it('ignores waitlisted and cancelled registrations when counting', async () => {
      // Only a confirmed seat is a seat. Counting the others would refuse a
      // reduction that is perfectly legitimate.
      const event = await createEvent({ capacity: 10 });
      await fillEvent(event.id, 2);

      const [waiting, gone] = await Promise.all([createAttendee(), createAttendee()]);
      await createRegistration({
        eventId: event.id,
        attendeeId: waiting.id,
        status: 'WAITLISTED',
        waitlistPosition: 1,
      });
      await createRegistration({
        eventId: event.id,
        attendeeId: gone.id,
        status: 'CANCELLED',
        cancelledAt: new Date(),
      });

      await expect(service.update(event.id, { capacity: 2 })).resolves.toMatchObject({
        capacity: 2,
      });
    });

    it('is still stopped by the CHECK constraint when the DTO is bypassed', async () => {
      // capacity >= 1 lives in the DTO validator, which only runs at the HTTP
      // boundary. Calling the service directly walks straight past it, and the
      // database still refuses — which is the whole argument for having the
      // constraint as well as the validator.
      const event = await createEvent({ capacity: 10 });

      await expect(service.update(event.id, { capacity: 0 })).rejects.toThrow();

      const stored = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(stored.capacity).toBe(10);
    });
  });
});
