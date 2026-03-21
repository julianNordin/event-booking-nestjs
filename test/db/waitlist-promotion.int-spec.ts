import { Test } from '@nestjs/testing';

import { Clock, SystemClock } from '../../src/common/clock/clock.service';
import {
  ResourceNotFoundError,
  TransitionNotAllowedError,
} from '../../src/common/errors/domain-error';
import { EventsService } from '../../src/events/events.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RegistrationsService } from '../../src/registrations/registrations.service';
import { WaitlistService } from '../../src/registrations/waitlist.service';
import { createAttendee, createEvent } from '../support/factories';
import { testPrisma } from '../support/prisma';

const prisma = testPrisma();

describe('waitlist promotion', () => {
  let service: RegistrationsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RegistrationsService,
        WaitlistService,
        { provide: PrismaService, useValue: testPrisma() },
        { provide: Clock, useClass: SystemClock },
      ],
    }).compile();

    service = moduleRef.get(RegistrationsService);
  });

  /** Fill an event to capacity, then queue `queued` more behind it. */
  async function fillAndQueue(
    capacity: number,
    queued: number,
  ): Promise<{ eventId: string; confirmed: string[]; waiting: string[] }> {
    const event = await createEvent({ capacity, waitlistEnabled: true });
    const confirmed: string[] = [];
    const waiting: string[] = [];

    for (let i = 0; i < capacity + queued; i += 1) {
      const attendee = await createAttendee();
      const registration = await service.register(event.id, { attendeeId: attendee.id });
      (registration.status === 'CONFIRMED' ? confirmed : waiting).push(registration.id);
    }

    expect(confirmed).toHaveLength(capacity);
    expect(waiting).toHaveLength(queued);

    return { eventId: event.id, confirmed, waiting };
  }

  const statusOf = async (id: string): Promise<string> =>
    (await prisma.registration.findUniqueOrThrow({ where: { id } })).status;

  describe('when a confirmed seat is given up', () => {
    it('promotes the front of the queue', async () => {
      const { confirmed, waiting } = await fillAndQueue(2, 2);

      await service.cancel(confirmed[0]!);

      await expect(statusOf(waiting[0]!)).resolves.toBe('CONFIRMED');
      await expect(statusOf(waiting[1]!)).resolves.toBe('WAITLISTED');
    });

    it('takes the promoted person out of the queue entirely', async () => {
      const { confirmed, waiting } = await fillAndQueue(1, 1);

      await service.cancel(confirmed[0]!);

      const promoted = await prisma.registration.findUniqueOrThrow({
        where: { id: waiting[0]! },
      });
      expect(promoted.status).toBe('CONFIRMED');
      expect(promoted.waitlistPosition).toBeNull();
    });

    it('keeps the event exactly at capacity', async () => {
      const { eventId, confirmed } = await fillAndQueue(3, 2);

      await service.cancel(confirmed[0]!);

      await expect(
        prisma.registration.count({ where: { eventId, status: 'CONFIRMED' } }),
      ).resolves.toBe(3);
    });

    it('promotes nobody when the queue is empty', async () => {
      const { eventId, confirmed } = await fillAndQueue(2, 0);

      await service.cancel(confirmed[0]!);

      await expect(
        prisma.registration.count({ where: { eventId, status: 'CONFIRMED' } }),
      ).resolves.toBe(1);
    });
  });

  describe('when a queued place is given up', () => {
    it('promotes nobody, because no seat was freed', async () => {
      // Leaving the queue frees nothing. Promoting here would confirm somebody
      // the event has no room for.
      const { eventId, waiting } = await fillAndQueue(1, 2);

      await service.cancel(waiting[0]!);

      await expect(
        prisma.registration.count({ where: { eventId, status: 'CONFIRMED' } }),
      ).resolves.toBe(1);
      await expect(statusOf(waiting[1]!)).resolves.toBe('WAITLISTED');
    });
  });

  describe('two cancellations at the same instant', () => {
    it('promotes two different people, not the same one twice', async () => {
      // The behaviour that matters: two seats freed means two people promoted,
      // in order.
      //
      // Removing the event lock does not reliably break this one, and that was
      // checked rather than assumed — PostgreSQL takes its own row lock on the
      // shared UPDATE of the front-of-queue registration, which serialises this
      // particular case by accident. The test that does fail deterministically
      // without the lock is the double-cancellation one below, three runs out
      // of three. This assertion is kept because it states the requirement; the
      // one below is what guards it.
      const { eventId, confirmed, waiting } = await fillAndQueue(2, 2);

      await Promise.all([service.cancel(confirmed[0]!), service.cancel(confirmed[1]!)]);

      const promoted = await Promise.all(waiting.map(statusOf));
      expect(promoted).toEqual(['CONFIRMED', 'CONFIRMED']);

      await expect(
        prisma.registration.count({ where: { eventId, status: 'CONFIRMED' } }),
      ).resolves.toBe(2);
      await expect(
        prisma.registration.count({ where: { eventId, status: 'WAITLISTED' } }),
      ).resolves.toBe(0);
    });

    it('never leaves a seat empty with somebody still queued', async () => {
      const { eventId, confirmed } = await fillAndQueue(3, 5);

      await Promise.all(confirmed.map((id) => service.cancel(id)));

      const [confirmedCount, waitingCount] = await Promise.all([
        prisma.registration.count({ where: { eventId, status: 'CONFIRMED' } }),
        prisma.registration.count({ where: { eventId, status: 'WAITLISTED' } }),
      ]);

      expect(confirmedCount).toBe(3);
      expect(waitingCount).toBe(2);
    });

    it('lets exactly one of two cancellations of the same registration succeed', async () => {
      const { confirmed } = await fillAndQueue(2, 1);
      const target = confirmed[0]!;

      const outcomes = await Promise.allSettled([service.cancel(target), service.cancel(target)]);

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        TransitionNotAllowedError,
      );
    });

    it('promotes exactly one person when the same seat is cancelled twice at once', async () => {
      // The failure this guards, and the one that actually goes red without the
      // event lock: both cancellations get past the status re-read, so the seat
      // is freed twice and the front of the queue is promoted twice while the
      // person behind never moves.
      const { eventId, confirmed } = await fillAndQueue(2, 2);
      const target = confirmed[0]!;

      await Promise.allSettled([service.cancel(target), service.cancel(target)]);

      await expect(
        prisma.registration.count({ where: { eventId, status: 'CONFIRMED' } }),
      ).resolves.toBe(2);
      await expect(
        prisma.registration.count({ where: { eventId, status: 'WAITLISTED' } }),
      ).resolves.toBe(1);
    });
  });

  describe('registering while the queue is being served', () => {
    it('does not let a new arrival take a seat owed to the queue', async () => {
      // Cancelling and promoting are one transaction, so there is no window in
      // which the seat is free and the queue is not being served.
      const { eventId, confirmed, waiting } = await fillAndQueue(1, 1);
      const newcomer = await createAttendee();

      await Promise.all([
        service.cancel(confirmed[0]!),
        service.register(eventId, { attendeeId: newcomer.id }).catch(() => undefined),
      ]);

      await expect(statusOf(waiting[0]!)).resolves.toBe('CONFIRMED');
      await expect(
        prisma.registration.count({ where: { eventId, status: 'CONFIRMED' } }),
      ).resolves.toBe(1);
    });
  });

  describe('raising capacity', () => {
    let events: EventsService;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          EventsService,
          WaitlistService,
          { provide: PrismaService, useValue: testPrisma() },
        ],
      }).compile();

      events = moduleRef.get(EventsService);
    });

    it('promotes the front of the queue when one seat is added', async () => {
      const { eventId, waiting } = await fillAndQueue(1, 2);

      await events.update(eventId, { capacity: 2 });

      await expect(statusOf(waiting[0]!)).resolves.toBe('CONFIRMED');
      await expect(statusOf(waiting[1]!)).resolves.toBe('WAITLISTED');
    });

    it('promotes in ticket order when several seats are added at once', async () => {
      // Adding three seats must take the first three, not any three.
      const { eventId, waiting } = await fillAndQueue(1, 5);

      await events.update(eventId, { capacity: 4 });

      const statuses = await Promise.all(waiting.map(statusOf));
      expect(statuses).toEqual(['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'WAITLISTED', 'WAITLISTED']);
    });

    it('promotes everyone and stops when the queue is shorter than the new seats', async () => {
      const { eventId, waiting } = await fillAndQueue(1, 2);

      await events.update(eventId, { capacity: 50 });

      const statuses = await Promise.all(waiting.map(statusOf));
      expect(statuses).toEqual(['CONFIRMED', 'CONFIRMED']);
      await expect(
        prisma.registration.count({ where: { eventId, status: 'WAITLISTED' } }),
      ).resolves.toBe(0);
    });

    it('leaves the queue alone when capacity does not change', async () => {
      const { eventId, waiting } = await fillAndQueue(1, 2);

      await events.update(eventId, { title: 'Renamed but the same size' });

      const statuses = await Promise.all(waiting.map(statusOf));
      expect(statuses).toEqual(['WAITLISTED', 'WAITLISTED']);
    });

    it('never promotes past the new capacity', async () => {
      const { eventId } = await fillAndQueue(2, 10);

      await events.update(eventId, { capacity: 5 + 0 });

      await expect(
        prisma.registration.count({ where: { eventId, status: 'CONFIRMED' } }),
      ).resolves.toBe(5);
    });

    it('does not race a registration arriving at the same moment', async () => {
      // The capacity change and the promotion are one transaction under the
      // event's lock, so a newcomer cannot slip into a seat that was created
      // for the queue.
      const { eventId, waiting } = await fillAndQueue(1, 1);
      const newcomer = await createAttendee();

      await Promise.all([
        events.update(eventId, { capacity: 2 }),
        service.register(eventId, { attendeeId: newcomer.id }),
      ]);

      await expect(statusOf(waiting[0]!)).resolves.toBe('CONFIRMED');
      await expect(
        prisma.registration.count({ where: { eventId, status: 'CONFIRMED' } }),
      ).resolves.toBe(2);
    });
  });

  describe('the waitlist endpoint', () => {
    it('raises not-found for an event that does not exist', async () => {
      await expect(
        service.findWaitlist('0195e3a0-0000-7000-8000-0000deadbeef'),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it('is empty for an event nobody is waiting for', async () => {
      const { eventId } = await fillAndQueue(2, 0);

      await expect(service.findWaitlist(eventId)).resolves.toEqual([]);
    });

    it('shows only the people still waiting, not the confirmed or the cancelled', async () => {
      const { eventId, waiting } = await fillAndQueue(1, 3);
      await service.cancel(waiting[1]!);

      const queue = await service.findWaitlist(eventId);

      expect(queue.map((entry) => entry.registrationId)).toEqual([waiting[0], waiting[2]]);
    });

    it('numbers places from one, in queue order', async () => {
      const { eventId } = await fillAndQueue(1, 3);

      const queue = await service.findWaitlist(eventId);

      expect(queue.map((entry) => entry.place)).toEqual([1, 2, 3]);
    });

    it('keeps places contiguous even where tickets have gaps', async () => {
      // Somebody in the middle leaves, so tickets 1 and 3 remain — but the
      // person holding ticket 3 is now second in line, and that is what they
      // are told. Renumbering the stored tickets to match would be an update
      // of every row behind every departure.
      const { eventId, waiting } = await fillAndQueue(1, 3);
      await service.cancel(waiting[1]!);

      const queue = await service.findWaitlist(eventId);

      expect(queue.map((entry) => entry.place)).toEqual([1, 2]);
      expect(queue.map((entry) => entry.waitlistPosition)).toEqual([1, 3]);
    });

    it('moves everyone up a place when the front of the queue is promoted', async () => {
      const { eventId, confirmed, waiting } = await fillAndQueue(1, 3);

      await service.cancel(confirmed[0]!);

      const queue = await service.findWaitlist(eventId);

      expect(queue.map((entry) => entry.registrationId)).toEqual([waiting[1], waiting[2]]);
      expect(queue.map((entry) => entry.place)).toEqual([1, 2]);
    });

    it('reports who is waiting and since when', async () => {
      const { eventId, waiting } = await fillAndQueue(1, 1);

      const [entry] = await service.findWaitlist(eventId);
      const stored = await prisma.registration.findUniqueOrThrow({ where: { id: waiting[0]! } });

      expect(entry?.attendeeId).toBe(stored.attendeeId);
      expect(entry?.registeredAt).toBe(stored.registeredAt.toISOString());
    });
  });
});
