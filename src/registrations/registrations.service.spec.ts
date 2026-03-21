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
import { WaitlistService } from './waitlist.service';

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
  const lockEvent = jest.fn();
  const findEventOrThrow = jest.fn();
  const findRegistrationOrThrow = jest.fn();
  const promote = jest.fn();

  // $transaction(fn) hands the callback a client scoped to the transaction.
  // Running it immediately against a stand-in lets these tests assert what
  // happened *inside* the transaction — including that the row lock was taken
  // before anything was counted.
  const $transaction = jest.fn(
    async (
      run: (tx: unknown) => Promise<unknown>,
      _options?: { maxWait: number; timeout: number },
    ) =>
      run({
        $queryRaw: lockEvent,
        event: { findUniqueOrThrow: findEventOrThrow },
        registration: {
          count,
          create,
          aggregate,
          findUniqueOrThrow: findRegistrationOrThrow,
          findMany,
          update,
        },
      }),
  );
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
    lockEvent.mockReset();
    findEventOrThrow.mockReset();
    findRegistrationOrThrow.mockReset();
    promote.mockReset();
    promote.mockResolvedValue([]);
    $transaction.mockClear();

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
            $transaction,
          },
        },
        // Time as an ordinary argument. Every rule below is a comparison
        // against this instant, and none of them touches the real clock.
        { provide: Clock, useValue: { now: () => NOW } },
        { provide: WaitlistService, useValue: { promote } },
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

  /**
   * The event, as both code paths see it: the row lock inside the transaction
   * returns it (or nothing, when it does not exist), and the plain lookup used
   * by the read paths returns the same thing.
   */
  function givenEvent(event: Partial<Event> | null): void {
    lockEvent.mockResolvedValue(event === null ? [] : [{ id: event.id ?? EVENT_ID }]);
    findEventOrThrow.mockResolvedValue(event);
    findEvent.mockResolvedValue(event);
  }

  /**
   * The registration, as both reads see it: the lookup outside the transaction
   * that decides which event to lock, and the authoritative re-read inside it.
   */
  function givenRegistration(registration: Registration | null): void {
    findRegistration.mockResolvedValue(registration);
    findRegistrationOrThrow.mockResolvedValue(registration);
  }

  function written(): Partial<Registration> {
    const calls = create.mock.calls as [{ data: Partial<Registration> }][];
    const first = calls[0];
    if (first === undefined) throw new Error('expected a registration to be written');
    return first[0].data;
  }

  describe('the things that must exist', () => {
    it('raises not-found when the event does not exist', async () => {
      givenEvent(null);

      await expect(service.register(EVENT_ID, { attendeeId: ATTENDEE_ID })).rejects.toBeInstanceOf(
        ResourceNotFoundError,
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('raises not-found when the attendee does not exist', async () => {
      // Checked explicitly rather than left to the foreign key: the constraint
      // would refuse too, but as a 409 about a relationship, where a person who
      // does not exist is a 404 about the person.
      givenEvent(anEvent());
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
      givenEvent(anEvent({ capacity: 10 }));
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
      givenEvent(anEvent({ capacity: 2, waitlistEnabled: true }));
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
      givenEvent(anEvent({ capacity: 2, waitlistEnabled: false }));

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
      givenEvent(anEvent(overrides));

      const error = await captureRuleViolation(() =>
        service.register(EVENT_ID, { attendeeId: ATTENDEE_ID }),
      );

      expect(error).toBeInstanceOf(RuleViolationError);
      expect(error.rule).toBe(rule);
      expect(error.status).toBe(409);
      expect(create).not.toHaveBeenCalled();
    });

    it('names the event and the attendee in the problem extensions', async () => {
      givenEvent(anEvent({ status: 'CANCELLED' }));

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
      givenEvent(anEvent({ startsAt: new Date(NOW.getTime() - DAY) }));
      findAttendee.mockResolvedValue({ id: ATTENDEE_ID });
      count.mockResolvedValue(0);

      await expect(service.register(EVENT_ID, { attendeeId: ATTENDEE_ID })).rejects.toBeInstanceOf(
        RuleViolationError,
      );
    });
  });

  describe('findForEvent', () => {
    it('raises not-found when the event does not exist', async () => {
      givenEvent(null);

      await expect(service.findForEvent(EVENT_ID)).rejects.toBeInstanceOf(ResourceNotFoundError);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('orders confirmed first, then the queue by position, then cancelled', async () => {
      // The enum is declared CONFIRMED, WAITLISTED, CANCELLED and PostgreSQL
      // sorts an enum by its declared order, so this ordering comes free.
      // Alphabetical would have put CANCELLED at the top of the door list.
      givenEvent({ id: EVENT_ID });
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
      givenEvent({ id: EVENT_ID });
      findMany.mockResolvedValue([aRegistration({ status: 'WAITLISTED', waitlistPosition: 2 })]);

      const [registration] = await service.findForEvent(EVENT_ID);

      expect(registration).toMatchObject({ status: 'WAITLISTED', waitlistPosition: 2 });
      expect(typeof registration?.registeredAt).toBe('string');
    });

    it('returns an empty list for an event nobody has registered for', async () => {
      givenEvent({ id: EVENT_ID });
      findMany.mockResolvedValue([]);

      await expect(service.findForEvent(EVENT_ID)).resolves.toEqual([]);
    });
  });

  describe('cancel', () => {
    beforeEach(() => {
      // Enough for the promotion pass to run and find nobody waiting, which is
      // the uninteresting case these tests are not about.
      givenEvent(anEvent({ capacity: 10 }));
      findEventOrThrow.mockResolvedValue({ capacity: 10, waitlistEnabled: true });
      count.mockResolvedValue(0);
      findMany.mockResolvedValue([]);
    });

    it('raises not-found for a registration that does not exist', async () => {
      givenRegistration(null);

      await expect(service.cancel('missing')).rejects.toBeInstanceOf(ResourceNotFoundError);
      expect(update).not.toHaveBeenCalled();
    });

    it('marks it cancelled and stamps the injected clock', async () => {
      givenRegistration(aRegistration({ status: 'CONFIRMED' }));
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
      givenRegistration(aRegistration({ status: 'WAITLISTED', waitlistPosition: 3 }));
      update.mockResolvedValue(aRegistration({ status: 'CANCELLED' }));

      await service.cancel('r1');

      const calls = update.mock.calls as [{ data: { waitlistPosition: number | null } }][];
      expect(calls[0]?.[0].data.waitlistPosition).toBeNull();
    });

    it('keeps the row rather than deleting it', async () => {
      // It is the record that this person held a place, and the partial unique
      // index ignores cancelled rows precisely so they can register again.
      givenRegistration(aRegistration({ status: 'CONFIRMED' }));
      update.mockResolvedValue(aRegistration({ status: 'CANCELLED' }));

      await service.cancel('r1');

      expect(deleteRegistration).not.toHaveBeenCalled();
    });

    it('refuses to cancel the same registration twice', async () => {
      // The refusal comes from the re-read inside the lock, which is what makes
      // two simultaneous cancellations refuse instead of promoting twice.
      givenRegistration(aRegistration({ status: 'CANCELLED' }));

      await expect(service.cancel('r1')).rejects.toBeInstanceOf(TransitionNotAllowedError);
      expect(update).not.toHaveBeenCalled();
    });

    it('cancels a waitlisted place as readily as a confirmed one', async () => {
      givenRegistration(aRegistration({ status: 'WAITLISTED', waitlistPosition: 1 }));
      update.mockResolvedValue(aRegistration({ status: 'CANCELLED' }));

      await expect(service.cancel('r1')).resolves.toMatchObject({ status: 'CANCELLED' });
    });
  });

  describe('findOne', () => {
    it('returns the registration', async () => {
      givenRegistration(aRegistration());

      await expect(service.findOne('r1')).resolves.toMatchObject({ status: 'CONFIRMED' });
    });

    it('raises not-found rather than returning null', async () => {
      givenRegistration(null);

      await expect(service.findOne('r1')).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  describe('the row lock', () => {
    beforeEach(() => {
      givenEvent(anEvent({ capacity: 10 }));
      findAttendee.mockResolvedValue({ id: ATTENDEE_ID });
      count.mockResolvedValue(0);
    });

    /** The SQL the service actually sent, reassembled from the tagged template. */
    function lockSql(): string {
      const calls = lockEvent.mock.calls as [TemplateStringsArray][];
      const first = calls[0];
      if (first === undefined) throw new Error('expected the event row to be locked');
      return first[0].join('?').replace(/\s+/g, ' ').trim();
    }

    it('is taken before anything is counted', async () => {
      // The entire fix, as an ordering assertion. Counting first and locking
      // afterwards reads a number that was already stale, and the lock then
      // protects nothing at all.
      await service.register(EVENT_ID, { attendeeId: ATTENDEE_ID });

      const lockedAt = lockEvent.mock.invocationCallOrder[0];
      const countedAt = count.mock.invocationCallOrder[0];

      expect(lockedAt).toBeDefined();
      expect(countedAt).toBeDefined();
      expect(lockedAt).toBeLessThan(countedAt ?? 0);
    });

    it('is a FOR UPDATE on one event row, not on the table', async () => {
      // Locking more than the contended row would serialise registrations for
      // every event in the system against each other.
      await service.register(EVENT_ID, { attendeeId: ATTENDEE_ID });

      expect(lockSql()).toMatch(/SELECT id FROM events WHERE id = \?::uuid FOR UPDATE/i);
    });

    it('parameterises the event id rather than interpolating it', async () => {
      // A tagged template sends the value as a bind parameter. Building this
      // string by concatenation would put a path segment straight into SQL.
      await service.register(EVENT_ID, { attendeeId: ATTENDEE_ID });

      expect(lockSql()).not.toContain(EVENT_ID);
      expect(lockEvent).toHaveBeenCalledWith(expect.anything(), EVENT_ID);
    });

    it('runs the decision and the insert in one transaction', async () => {
      await service.register(EVENT_ID, { attendeeId: ATTENDEE_ID });

      expect($transaction).toHaveBeenCalledTimes(1);
    });

    it('states its own timeouts rather than taking Prisma’s defaults', async () => {
      // With a queue of contenders behind one lock, the last in line waits for
      // everyone ahead. Prisma's 2s/5s defaults would start refusing people for
      // a reason that has nothing to do with capacity.
      await service.register(EVENT_ID, { attendeeId: ATTENDEE_ID });

      expect($transaction.mock.calls[0]?.[1]).toEqual({ maxWait: 5_000, timeout: 10_000 });
    });

    it('raises not-found when the lock matches no event', async () => {
      // The existence check moved inside the transaction with the lock, so a
      // deleted event is caught by the same query that serialises the rest.
      givenEvent(null);

      await expect(service.register(EVENT_ID, { attendeeId: ATTENDEE_ID })).rejects.toBeInstanceOf(
        ResourceNotFoundError,
      );
      expect(count).not.toHaveBeenCalled();
    });

    it('checks the attendee outside the transaction, keeping the lock short', async () => {
      // Whether this person exists has nothing to do with the capacity race,
      // and doing it inside would hold the event row while finding out.
      findAttendee.mockResolvedValue(null);

      await expect(service.register(EVENT_ID, { attendeeId: ATTENDEE_ID })).rejects.toBeInstanceOf(
        ResourceNotFoundError,
      );
      expect($transaction).not.toHaveBeenCalled();
    });

    it('reads the waitlist position inside the transaction too', async () => {
      // Read outside the lock, two registrations would see the same maximum
      // and be handed the same position — the capacity race one layer along.
      givenEvent(anEvent({ capacity: 1, waitlistEnabled: true }));
      count.mockResolvedValue(1);
      aggregate.mockResolvedValue({ _max: { waitlistPosition: 2 } });

      await service.register(EVENT_ID, { attendeeId: ATTENDEE_ID });

      const aggregatedAt = aggregate.mock.invocationCallOrder[0] ?? 0;
      const lockedAt = lockEvent.mock.invocationCallOrder[0] ?? 0;
      expect(aggregatedAt).toBeGreaterThan(lockedAt);
      expect(written()).toMatchObject({ waitlistPosition: 3 });
    });
  });
});
