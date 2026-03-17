import { Test } from '@nestjs/testing';

import { Clock } from '../common/clock/clock.service';
import {
  ResourceNotFoundError,
  RuleViolationError,
  TransitionNotAllowedError,
} from '../common/errors/domain-error';
import type { Event, Registration } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RegistrationsService } from './registrations.service';

const NOW = new Date('2027-06-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const EVENT_ID = '0195e3a0-0000-7000-8000-0000000000e1';
const ATTENDEE_ID = '0195e3a0-0000-7000-8000-0000000000a1';

function anEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: EVENT_ID,
    title: 'Distributed Systems in Practice',
    description: null,
    venue: 'Norra Latin',
    startsAt: new Date(NOW.getTime() + 30 * DAY),
    endsAt: new Date(NOW.getTime() + 31 * DAY),
    capacity: 10,
    waitlistEnabled: true,
    registrationOpensAt: null,
    registrationClosesAt: null,
    status: 'PUBLISHED',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function aRegistration(overrides: Partial<Registration> = {}): Registration {
  return {
    id: '0195e3a0-0000-7000-8000-0000000000c1',
    eventId: EVENT_ID,
    attendeeId: ATTENDEE_ID,
    status: 'CONFIRMED',
    waitlistPosition: null,
    registeredAt: NOW,
    cancelledAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('RegistrationsService', () => {
  const findEvent = jest.fn();
  const findAttendee = jest.fn();
  const count = jest.fn();
  const create = jest.fn();
  const aggregate = jest.fn();
  const findRegistration = jest.fn();
  const findMany = jest.fn();
  const update = jest.fn();
  const deleteRegistration = jest.fn();
  let service: RegistrationsService;

  beforeEach(async () => {
    findEvent.mockReset();
    findAttendee.mockReset();
    count.mockReset();
    create.mockReset();
    aggregate.mockReset();
    findRegistration.mockReset();
    findMany.mockReset();
    update.mockReset();
    deleteRegistration.mockReset();

    aggregate.mockResolvedValue({ _max: { waitlistPosition: null } });
    create.mockImplementation(({ data }: { data: Partial<Registration> }) =>
      Promise.resolve(aRegistration(data)),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        RegistrationsService,
        {
          provide: PrismaService,
          useValue: {
            event: { findUnique: findEvent },
            attendee: { findUnique: findAttendee },
            registration: {
              count,
              create,
              aggregate,
              findUnique: findRegistration,
              findMany,
              update,
              delete: deleteRegistration,
            },
          },
        },
        // Time as an ordinary argument. Every rule below is a comparison
        // against this instant, and none of them touches the real clock.
        { provide: Clock, useValue: { now: () => NOW } },
      ],
    }).compile();

    service = moduleRef.get(RegistrationsService);
  });

  /**
   * Awaiting a rejection through .catch() widens the type to a union with the
   * success value, so every assertion on the error then needs a cast. This
   * narrows once, in one place.
   */
  async function captureRuleViolation(
    operation: () => Promise<unknown>,
  ): Promise<RuleViolationError> {
    try {
      await operation();
    } catch (error) {
      return error as RuleViolationError;
    }
    throw new Error('expected the service to refuse this registration');
  }

  function written(): Partial<Registration> {
    const calls = create.mock.calls as [{ data: Partial<Registration> }][];
    const first = calls[0];
    if (first === undefined) throw new Error('expected a registration to be written');
    return first[0].data;
  }

  describe('the things that must exist', () => {
    it('raises not-found when the event does not exist', async () => {
      findEvent.mockResolvedValue(null);

      await expect(service.register(EVENT_ID, { attendeeId: ATTENDEE_ID })).rejects.toBeInstanceOf(
        ResourceNotFoundError,
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('raises not-found when the attendee does not exist', async () => {
      // Checked explicitly rather than left to the foreign key: the constraint
      // would refuse too, but as a 409 about a relationship, where a person who
      // does not exist is a 404 about the person.
      findEvent.mockResolvedValue(anEvent());
      findAttendee.mockResolvedValue(null);

      const error = await service
        .register(EVENT_ID, { attendeeId: ATTENDEE_ID })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).resource).toBe('attendee');
    });
  });

  describe('a confirmed seat', () => {
    beforeEach(() => {
      findEvent.mockResolvedValue(anEvent({ capacity: 10 }));
      findAttendee.mockResolvedValue({ id: ATTENDEE_ID });
      count.mockResolvedValue(3);
    });

    it('is written with no waitlist position', async () => {
      await service.register(EVENT_ID, { attendeeId: ATTENDEE_ID });

      expect(written()).toEqual({
        eventId: EVENT_ID,
        attendeeId: ATTENDEE_ID,
        status: 'CONFIRMED',
        waitlistPosition: null,
      });
    });

    it('counts only confirmed registrations when deciding', async () => {
      // Waitlisted and cancelled rows do not occupy a seat. Counting them would
      // waitlist people while the room is half empty.
      await service.register(EVENT_ID, { attendeeId: ATTENDEE_ID });

      expect(count).toHaveBeenCalledWith({ where: { eventId: EVENT_ID, status: 'CONFIRMED' } });
    });

    it('returns a response DTO', async () => {
      const registration = await service.register(EVENT_ID, { attendeeId: ATTENDEE_ID });

      expect(typeof registration.registeredAt).toBe('string');
      expect(registration.status).toBe('CONFIRMED');
    });
  });

  describe('a full event', () => {
    beforeEach(() => {
      findEvent.mockResolvedValue(anEvent({ capacity: 2, waitlistEnabled: true }));
      findAttendee.mockResolvedValue({ id: ATTENDEE_ID });
      count.mockResolvedValue(2);
    });

    it('waitlists at position one when the queue is empty', async () => {
      aggregate.mockResolvedValue({ _max: { waitlistPosition: null } });

      await service.register(EVENT_ID, { attendeeId: ATTENDEE_ID });

      expect(written()).toMatchObject({ status: 'WAITLISTED', waitlistPosition: 1 });
    });

    it('takes the position after the highest currently held', async () => {
      // Derived from the maximum rather than from a count: counting would
      // re-use a position the moment somebody in the middle of the queue
      // cancelled, and two people would hold the same place.
      aggregate.mockResolvedValue({ _max: { waitlistPosition: 4 } });

      await service.register(EVENT_ID, { attendeeId: ATTENDEE_ID });

      expect(written()).toMatchObject({ waitlistPosition: 5 });
    });

    it('refuses outright when the waitlist is disabled', async () => {
      findEvent.mockResolvedValue(anEvent({ capacity: 2, waitlistEnabled: false }));

      const error = await captureRuleViolation(() =>
        service.register(EVENT_ID, { attendeeId: ATTENDEE_ID }),
      );

      expect(error).toBeInstanceOf(RuleViolationError);
      expect(error.rule).toBe('event-full');
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('refusals carry the rule that was broken', () => {
    beforeEach(() => {
      findAttendee.mockResolvedValue({ id: ATTENDEE_ID });
      count.mockResolvedValue(0);
    });

    it.each([
      ['a draft event', { status: 'DRAFT' as const }, 'event-not-published'],
      ['a cancelled event', { status: 'CANCELLED' as const }, 'event-cancelled'],
      [
        'registration not yet open',
        { registrationOpensAt: new Date(NOW.getTime() + DAY) },
        'registration-not-open',
      ],
      [
        'registration closed',
        { registrationClosesAt: new Date(NOW.getTime() - DAY) },
        'registration-closed',
      ],
      [
        'an event already under way',
        { startsAt: new Date(NOW.getTime() - DAY) },
        'event-already-started',
      ],
    ])('refuses %s as %s', async (_label, overrides, rule) => {
      findEvent.mockResolvedValue(anEvent(overrides));

      const error = await captureRuleViolation(() =>
        service.register(EVENT_ID, { attendeeId: ATTENDEE_ID }),
      );

      expect(error).toBeInstanceOf(RuleViolationError);
      expect(error.rule).toBe(rule);
      expect(error.status).toBe(409);
      expect(create).not.toHaveBeenCalled();
    });

    it('names the event and the attendee in the problem extensions', async () => {
      findEvent.mockResolvedValue(anEvent({ status: 'CANCELLED' }));

      const error = await captureRuleViolation(() =>
        service.register(EVENT_ID, { attendeeId: ATTENDEE_ID }),
      );

      expect(error.extensions()).toMatchObject({
        rule: 'event-cancelled',
        eventId: EVENT_ID,
        attendeeId: ATTENDEE_ID,
      });
    });
  });

  describe('the clock', () => {
    it('is the injected one, not the wall clock', async () => {
      // The event starts a day before the frozen "now", so this is only refused
      // if the service is reading the clock it was given.
      findEvent.mockResolvedValue(anEvent({ startsAt: new Date(NOW.getTime() - DAY) }));
      findAttendee.mockResolvedValue({ id: ATTENDEE_ID });
      count.mockResolvedValue(0);

      await expect(service.register(EVENT_ID, { attendeeId: ATTENDEE_ID })).rejects.toBeInstanceOf(
        RuleViolationError,
      );
    });
  });

  describe('findForEvent', () => {
    it('raises not-found when the event does not exist', async () => {
      findEvent.mockResolvedValue(null);

      await expect(service.findForEvent(EVENT_ID)).rejects.toBeInstanceOf(ResourceNotFoundError);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('orders confirmed first, then the queue by position, then cancelled', async () => {
      // The enum is declared CONFIRMED, WAITLISTED, CANCELLED and PostgreSQL
      // sorts an enum by its declared order, so this ordering comes free.
      // Alphabetical would have put CANCELLED at the top of the door list.
      findEvent.mockResolvedValue({ id: EVENT_ID });
      findMany.mockResolvedValue([]);

      await service.findForEvent(EVENT_ID);

      expect(findMany).toHaveBeenCalledWith({
        where: { eventId: EVENT_ID },
        orderBy: [
          { status: 'asc' },
          { waitlistPosition: { sort: 'asc', nulls: 'last' } },
          { registeredAt: 'asc' },
          { id: 'asc' },
        ],
      });
    });

    it('maps them to response DTOs', async () => {
      findEvent.mockResolvedValue({ id: EVENT_ID });
      findMany.mockResolvedValue([aRegistration({ status: 'WAITLISTED', waitlistPosition: 2 })]);

      const [registration] = await service.findForEvent(EVENT_ID);

      expect(registration).toMatchObject({ status: 'WAITLISTED', waitlistPosition: 2 });
      expect(typeof registration?.registeredAt).toBe('string');
    });

    it('returns an empty list for an event nobody has registered for', async () => {
      findEvent.mockResolvedValue({ id: EVENT_ID });
      findMany.mockResolvedValue([]);

      await expect(service.findForEvent(EVENT_ID)).resolves.toEqual([]);
    });
  });

  describe('cancel', () => {
    it('raises not-found for a registration that does not exist', async () => {
      findRegistration.mockResolvedValue(null);

      await expect(service.cancel('missing')).rejects.toBeInstanceOf(ResourceNotFoundError);
      expect(update).not.toHaveBeenCalled();
    });

    it('marks it cancelled and stamps the injected clock', async () => {
      findRegistration.mockResolvedValue(aRegistration({ status: 'CONFIRMED' }));
      update.mockResolvedValue(aRegistration({ status: 'CANCELLED', cancelledAt: NOW }));

      await service.cancel('r1');

      expect(update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { status: 'CANCELLED', cancelledAt: NOW, waitlistPosition: null },
      });
    });

    it('vacates the waitlist position as well as the status', async () => {
      // A cancelled row that keeps its position still claims a place in a queue
      // it has left, and the next promotion would skip over it.
      findRegistration.mockResolvedValue(
        aRegistration({ status: 'WAITLISTED', waitlistPosition: 3 }),
      );
      update.mockResolvedValue(aRegistration({ status: 'CANCELLED' }));

      await service.cancel('r1');

      const calls = update.mock.calls as [{ data: { waitlistPosition: number | null } }][];
      expect(calls[0]?.[0].data.waitlistPosition).toBeNull();
    });

    it('keeps the row rather than deleting it', async () => {
      // It is the record that this person held a place, and the partial unique
      // index ignores cancelled rows precisely so they can register again.
      findRegistration.mockResolvedValue(aRegistration({ status: 'CONFIRMED' }));
      update.mockResolvedValue(aRegistration({ status: 'CANCELLED' }));

      await service.cancel('r1');

      expect(deleteRegistration).not.toHaveBeenCalled();
    });

    it('refuses to cancel the same registration twice', async () => {
      findRegistration.mockResolvedValue(aRegistration({ status: 'CANCELLED' }));

      await expect(service.cancel('r1')).rejects.toBeInstanceOf(TransitionNotAllowedError);
      expect(update).not.toHaveBeenCalled();
    });

    it('cancels a waitlisted place as readily as a confirmed one', async () => {
      findRegistration.mockResolvedValue(
        aRegistration({ status: 'WAITLISTED', waitlistPosition: 1 }),
      );
      update.mockResolvedValue(aRegistration({ status: 'CANCELLED' }));

      await expect(service.cancel('r1')).resolves.toMatchObject({ status: 'CANCELLED' });
    });
  });

  describe('findOne', () => {
    it('returns the registration', async () => {
      findRegistration.mockResolvedValue(aRegistration());

      await expect(service.findOne('r1')).resolves.toMatchObject({ status: 'CONFIRMED' });
    });

    it('raises not-found rather than returning null', async () => {
      findRegistration.mockResolvedValue(null);

      await expect(service.findOne('r1')).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });
});
