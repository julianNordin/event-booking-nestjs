import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';

import { Clock } from '../../src/common/clock/clock.service';
import {
  AlreadyExistsError,
  ResourceNotFoundError,
  RuleViolationError,
  TransitionNotAllowedError,
} from '../../src/common/errors/domain-error';
import { mapPrismaError } from '../../src/common/filters/prisma-error.mapper';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RegistrationsService } from '../../src/registrations/registrations.service';
import { WaitlistService } from '../../src/registrations/waitlist.service';
import { createAttendee, createEvent, createRegistration } from '../support/factories';
import { testPrisma } from '../support/prisma';

const prisma = testPrisma();
const DAY = 24 * 60 * 60 * 1000;

/** A clock the tests can move, so "now" is an argument rather than the wall clock. */
class MovableClock extends Clock {
  private current = new Date();

  now(): Date {
    return this.current;
  }

  set(instant: Date): void {
    this.current = instant;
  }
}

async function capture(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail');
}

describe('registrations against a real database', () => {
  let service: RegistrationsService;
  let clock: MovableClock;

  beforeAll(async () => {
    clock = new MovableClock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        RegistrationsService,
        WaitlistService,
        EventEmitter2,
        { provide: PrismaService, useValue: testPrisma() },
        { provide: Clock, useValue: clock },
      ],
    }).compile();

    service = moduleRef.get(RegistrationsService);
  });

  beforeEach(() => {
    clock.set(new Date());
  });

  describe('the happy path', () => {
    it('confirms a seat while there is room', async () => {
      const event = await createEvent({ capacity: 3 });
      const attendee = await createAttendee();

      const registration = await service.register(event.id, { attendeeId: attendee.id });

      expect(registration.status).toBe('CONFIRMED');
      expect(registration.waitlistPosition).toBeNull();

      const stored = await prisma.registration.findUniqueOrThrow({
        where: { id: registration.id },
      });
      expect(stored.status).toBe('CONFIRMED');
    });

    it('fills an event exactly to capacity', async () => {
      const event = await createEvent({ capacity: 3 });

      for (let i = 0; i < 3; i += 1) {
        const attendee = await createAttendee();
        const registration = await service.register(event.id, { attendeeId: attendee.id });
        expect(registration.status).toBe('CONFIRMED');
      }

      await expect(
        prisma.registration.count({ where: { eventId: event.id, status: 'CONFIRMED' } }),
      ).resolves.toBe(3);
    });
  });

  describe('the waitlist', () => {
    it('waitlists the first person past capacity at position one', async () => {
      const event = await createEvent({ capacity: 1, waitlistEnabled: true });
      await service.register(event.id, { attendeeId: (await createAttendee()).id });

      const overflow = await service.register(event.id, {
        attendeeId: (await createAttendee()).id,
      });

      expect(overflow.status).toBe('WAITLISTED');
      expect(overflow.waitlistPosition).toBe(1);
    });

    it('numbers the queue in arrival order', async () => {
      const event = await createEvent({ capacity: 1, waitlistEnabled: true });
      await service.register(event.id, { attendeeId: (await createAttendee()).id });

      const positions: (number | null)[] = [];
      for (let i = 0; i < 3; i += 1) {
        const registration = await service.register(event.id, {
          attendeeId: (await createAttendee()).id,
        });
        positions.push(registration.waitlistPosition);
      }

      expect(positions).toEqual([1, 2, 3]);
    });

    it('does not re-use a position after someone in the queue cancels', async () => {
      // The bug a count-based position would have: cancel number two, and the
      // next arrival would be handed two again.
      const event = await createEvent({ capacity: 1, waitlistEnabled: true });
      await service.register(event.id, { attendeeId: (await createAttendee()).id });

      const first = await service.register(event.id, { attendeeId: (await createAttendee()).id });
      const second = await service.register(event.id, { attendeeId: (await createAttendee()).id });
      expect([first.waitlistPosition, second.waitlistPosition]).toEqual([1, 2]);

      await service.cancel(first.id);

      const third = await service.register(event.id, { attendeeId: (await createAttendee()).id });
      expect(third.waitlistPosition).toBe(3);
    });

    it('refuses outright when the event is full and the waitlist is off', async () => {
      const event = await createEvent({ capacity: 1, waitlistEnabled: false });
      await service.register(event.id, { attendeeId: (await createAttendee()).id });

      const hopeful = await createAttendee();
      const error = (await capture(() =>
        service.register(event.id, { attendeeId: hopeful.id }),
      )) as RuleViolationError;

      expect(error).toBeInstanceOf(RuleViolationError);
      expect(error.rule).toBe('event-full');
    });
  });

  describe('what must exist', () => {
    it('raises not-found for an unknown event', async () => {
      const attendee = await createAttendee();

      await expect(
        service.register('0195e3a0-0000-7000-8000-0000deadbeef', { attendeeId: attendee.id }),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it('raises not-found for an unknown attendee', async () => {
      const event = await createEvent();

      await expect(
        service.register(event.id, { attendeeId: '0195e3a0-0000-7000-8000-0000deadbeef' }),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  describe('the event lifecycle', () => {
    it.each([
      ['DRAFT', 'event-not-published'],
      ['CANCELLED', 'event-cancelled'],
    ] as const)('refuses registration for a %s event', async (status, rule) => {
      const event = await createEvent({ status });
      const attendee = await createAttendee();

      const error = (await capture(() =>
        service.register(event.id, { attendeeId: attendee.id }),
      )) as RuleViolationError;

      expect(error.rule).toBe(rule);
      await expect(prisma.registration.count()).resolves.toBe(0);
    });

    it('refuses once the event has started, using the injected clock', async () => {
      const event = await createEvent({ startsAt: new Date(Date.now() + 2 * DAY) });
      const attendee = await createAttendee();

      // Move time past the start rather than creating an event in the past,
      // which the CHECK constraints and the factory would both resist.
      clock.set(new Date(Date.now() + 3 * DAY));

      const error = (await capture(() =>
        service.register(event.id, { attendeeId: attendee.id }),
      )) as RuleViolationError;

      expect(error.rule).toBe('event-already-started');
    });

    it('refuses before registration opens and accepts once it has', async () => {
      const opensAt = new Date(Date.now() + 1 * DAY);
      const event = await createEvent({
        startsAt: new Date(Date.now() + 10 * DAY),
        registrationOpensAt: opensAt,
      });
      const attendee = await createAttendee();

      const error = (await capture(() =>
        service.register(event.id, { attendeeId: attendee.id }),
      )) as RuleViolationError;
      expect(error.rule).toBe('registration-not-open');

      clock.set(new Date(opensAt.getTime() + 1000));

      await expect(service.register(event.id, { attendeeId: attendee.id })).resolves.toMatchObject({
        status: 'CONFIRMED',
      });
    });
  });

  describe('registering twice', () => {
    it('is refused by the partial unique index', async () => {
      const event = await createEvent({ capacity: 5 });
      const attendee = await createAttendee();
      await service.register(event.id, { attendeeId: attendee.id });

      const raw = await capture(() => service.register(event.id, { attendeeId: attendee.id }));

      expect(mapPrismaError(raw)).toBeInstanceOf(AlreadyExistsError);
      expect(mapPrismaError(raw)?.extensions()).toEqual({ conflictingOn: 'eventId+attendeeId' });
    });

    it('is permitted again after cancelling', async () => {
      // The reason the index is partial, exercised through the service rather
      // than by writing rows directly.
      const event = await createEvent({ capacity: 5 });
      const attendee = await createAttendee();

      const first = await service.register(event.id, { attendeeId: attendee.id });
      await service.cancel(first.id);

      await expect(service.register(event.id, { attendeeId: attendee.id })).resolves.toMatchObject({
        status: 'CONFIRMED',
      });
      await expect(
        prisma.registration.count({ where: { eventId: event.id, attendeeId: attendee.id } }),
      ).resolves.toBe(2);
    });
  });

  describe('cancelling', () => {
    it('marks the row cancelled and keeps it', async () => {
      const event = await createEvent();
      const attendee = await createAttendee();
      const registration = await service.register(event.id, { attendeeId: attendee.id });

      const cancelled = await service.cancel(registration.id);

      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancelledAt).not.toBeNull();
      await expect(prisma.registration.count()).resolves.toBe(1);
    });

    it('frees the seat for someone else', async () => {
      const event = await createEvent({ capacity: 1, waitlistEnabled: false });
      const first = await service.register(event.id, {
        attendeeId: (await createAttendee()).id,
      });

      await service.cancel(first.id);

      await expect(
        service.register(event.id, { attendeeId: (await createAttendee()).id }),
      ).resolves.toMatchObject({ status: 'CONFIRMED' });
    });

    it('refuses to cancel twice', async () => {
      const event = await createEvent();
      const registration = await service.register(event.id, {
        attendeeId: (await createAttendee()).id,
      });
      await service.cancel(registration.id);

      await expect(service.cancel(registration.id)).rejects.toBeInstanceOf(
        TransitionNotAllowedError,
      );
    });
  });

  describe('listing an event roster', () => {
    it('puts confirmed seats first, then the queue in order, then the cancelled', async () => {
      const event = await createEvent({ capacity: 2, waitlistEnabled: true });
      const [a, b, c, d] = await Promise.all([
        createAttendee(),
        createAttendee(),
        createAttendee(),
        createAttendee(),
      ]);

      await createRegistration({ eventId: event.id, attendeeId: a.id, status: 'CONFIRMED' });
      await createRegistration({ eventId: event.id, attendeeId: b.id, status: 'CONFIRMED' });
      await createRegistration({
        eventId: event.id,
        attendeeId: c.id,
        status: 'WAITLISTED',
        waitlistPosition: 2,
      });
      await createRegistration({
        eventId: event.id,
        attendeeId: d.id,
        status: 'CANCELLED',
        cancelledAt: new Date(),
      });

      const roster = await service.findForEvent(event.id);

      expect(roster.map((registration) => registration.status)).toEqual([
        'CONFIRMED',
        'CONFIRMED',
        'WAITLISTED',
        'CANCELLED',
      ]);
    });

    it('orders the queue by position, not by arrival', async () => {
      const event = await createEvent({ capacity: 0 + 1 });
      const [first, second] = await Promise.all([createAttendee(), createAttendee()]);

      // Written out of order on purpose.
      await createRegistration({
        eventId: event.id,
        attendeeId: first.id,
        status: 'WAITLISTED',
        waitlistPosition: 5,
      });
      await createRegistration({
        eventId: event.id,
        attendeeId: second.id,
        status: 'WAITLISTED',
        waitlistPosition: 2,
      });

      const roster = await service.findForEvent(event.id);

      expect(roster.map((registration) => registration.waitlistPosition)).toEqual([2, 5]);
    });

    it('raises not-found for an event that does not exist', async () => {
      await expect(
        service.findForEvent('0195e3a0-0000-7000-8000-0000deadbeef'),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });
});
