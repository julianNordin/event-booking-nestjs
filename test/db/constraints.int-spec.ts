import { captureViolation } from '../support/expect-violation';
import { createAttendee, createEvent, createRegistration } from '../support/factories';
import { testPrisma } from '../support/prisma';

const prisma = testPrisma();
const DAY = 24 * 60 * 60 * 1000;

/**
 * The four constraints that Prisma's schema language cannot express, tested
 * against a real PostgreSQL because there is nowhere else they exist.
 *
 * Each one is asserted twice over: that the rejection happens, and that it is
 * *this* constraint rejecting it. Without the second half a test still passes
 * when the write fails for an unrelated reason — a null violation, a bad
 * foreign key — and quietly stops covering the thing it was written for.
 */
describe('constraints that only exist in hand-written SQL', () => {
  describe('ck_events_capacity', () => {
    it('refuses an event with no seats', async () => {
      const violation = await captureViolation(() => createEvent({ capacity: 0 }));

      expect(violation.code).toBe('P2039');
      expect(violation.sqlState).toBe('23514');
      expect(violation.constraint).toBe('ck_events_capacity');
    });

    it('refuses a negative capacity', async () => {
      const violation = await captureViolation(() => createEvent({ capacity: -5 }));

      expect(violation.constraint).toBe('ck_events_capacity');
    });

    it('accepts the smallest legal event', async () => {
      await expect(createEvent({ capacity: 1 })).resolves.toMatchObject({ capacity: 1 });
    });
  });

  describe('ck_events_ends_after', () => {
    it('refuses an event that ends when it starts', async () => {
      const startsAt = new Date(Date.now() + 7 * DAY);
      const violation = await captureViolation(() => createEvent({ startsAt, endsAt: startsAt }));

      expect(violation.code).toBe('P2039');
      expect(violation.sqlState).toBe('23514');
      expect(violation.constraint).toBe('ck_events_ends_after');
    });

    it('refuses an event that ends before it starts', async () => {
      const startsAt = new Date(Date.now() + 7 * DAY);
      const violation = await captureViolation(() =>
        createEvent({ startsAt, endsAt: new Date(startsAt.getTime() - 1000) }),
      );

      expect(violation.constraint).toBe('ck_events_ends_after');
    });

    it('accepts an event one millisecond long', async () => {
      const startsAt = new Date(Date.now() + 7 * DAY);

      await expect(
        createEvent({ startsAt, endsAt: new Date(startsAt.getTime() + 1) }),
      ).resolves.toBeDefined();
    });
  });

  describe('ux_attendees_email_lower', () => {
    it('refuses the same address twice', async () => {
      await createAttendee({ email: 'ada@example.com' });
      const violation = await captureViolation(() => createAttendee({ email: 'ada@example.com' }));

      expect(violation.code).toBe('P2002');
      expect(violation.constraint).toBe('ux_attendees_email_lower');
    });

    it('refuses the same address in different case', async () => {
      // The whole reason this index is functional rather than plain. Two people
      // called Ada is a support ticket; one person with two accounts is a bug.
      await createAttendee({ email: 'ada@example.com' });
      const violation = await captureViolation(() => createAttendee({ email: 'Ada@Example.COM' }));

      expect(violation.code).toBe('P2002');
      expect(violation.constraint).toBe('ux_attendees_email_lower');
    });

    it('allows genuinely different addresses', async () => {
      await createAttendee({ email: 'ada@example.com' });

      await expect(createAttendee({ email: 'ada+work@example.com' })).resolves.toBeDefined();
    });
  });

  describe('ux_registration_active', () => {
    it('refuses a second confirmed registration for the same pair', async () => {
      const event = await createEvent();
      const attendee = await createAttendee();
      await createRegistration({ eventId: event.id, attendeeId: attendee.id });

      const violation = await captureViolation(() =>
        createRegistration({ eventId: event.id, attendeeId: attendee.id }),
      );

      expect(violation.code).toBe('P2002');
      expect(violation.constraint).toBe('ux_registration_active');
    });

    it('refuses a waitlist place alongside a confirmed seat', async () => {
      // Both statuses are "active", so holding one of each is the same person
      // counted twice.
      const event = await createEvent();
      const attendee = await createAttendee();
      await createRegistration({ eventId: event.id, attendeeId: attendee.id });

      const violation = await captureViolation(() =>
        createRegistration({
          eventId: event.id,
          attendeeId: attendee.id,
          status: 'WAITLISTED',
          waitlistPosition: 1,
        }),
      );

      expect(violation.constraint).toBe('ux_registration_active');
    });

    it('permits registering again after cancelling', async () => {
      // The reason the index is partial. A plain unique index passes every test
      // above and fails this one, and the failure only shows up when a real
      // person changes their mind.
      const event = await createEvent();
      const attendee = await createAttendee();
      const first = await createRegistration({ eventId: event.id, attendeeId: attendee.id });

      await prisma.registration.update({
        where: { id: first.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      await expect(
        createRegistration({ eventId: event.id, attendeeId: attendee.id }),
      ).resolves.toMatchObject({ status: 'CONFIRMED' });

      await expect(
        prisma.registration.count({ where: { eventId: event.id, attendeeId: attendee.id } }),
      ).resolves.toBe(2);
    });

    it('permits any number of cancelled registrations for the same pair', async () => {
      const event = await createEvent();
      const attendee = await createAttendee();

      for (let i = 0; i < 3; i += 1) {
        const registration = await createRegistration({
          eventId: event.id,
          attendeeId: attendee.id,
        });
        await prisma.registration.update({
          where: { id: registration.id },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });
      }

      await expect(prisma.registration.count({ where: { status: 'CANCELLED' } })).resolves.toBe(3);
    });

    it('constrains the pair, not the attendee', async () => {
      const [first, second] = await Promise.all([createEvent(), createEvent()]);
      const attendee = await createAttendee();

      await createRegistration({ eventId: first.id, attendeeId: attendee.id });

      await expect(
        createRegistration({ eventId: second.id, attendeeId: attendee.id }),
      ).resolves.toBeDefined();
    });

    it('constrains the pair, not the event', async () => {
      const event = await createEvent();
      const [ada, bo] = await Promise.all([createAttendee(), createAttendee()]);

      await createRegistration({ eventId: event.id, attendeeId: ada.id });

      await expect(
        createRegistration({ eventId: event.id, attendeeId: bo.id }),
      ).resolves.toBeDefined();
    });
  });
});
