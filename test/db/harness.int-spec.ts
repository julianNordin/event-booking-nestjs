import { createAttendee, createEvent, createRegistration, fillEvent } from '../support/factories';
import { testPrisma } from '../support/prisma';

const prisma = testPrisma();

describe('the integration harness', () => {
  describe('isolation between tests', () => {
    // These two run in order, and the second is the assertion that matters:
    // without truncation it sees the rows the first one left and fails. A suite
    // where tests can see each other's data is one where the failure you get is
    // rarely the bug you have.
    it('keeps rows written during a test', async () => {
      await createEvent();
      await createEvent();

      await expect(prisma.event.count()).resolves.toBe(2);
    });

    it('starts the next test against an empty database', async () => {
      await expect(prisma.event.count()).resolves.toBe(0);
      await expect(prisma.attendee.count()).resolves.toBe(0);
      await expect(prisma.registration.count()).resolves.toBe(0);
    });
  });

  describe('the factories', () => {
    it('produce an event that satisfies every constraint without being told to', async () => {
      const event = await createEvent();

      expect(event.endsAt.getTime()).toBeGreaterThan(event.startsAt.getTime());
      expect(event.capacity).toBeGreaterThanOrEqual(1);
      expect(event.startsAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('let a test state only the field it is about', async () => {
      const event = await createEvent({ capacity: 1, status: 'DRAFT' });

      expect(event.capacity).toBe(1);
      expect(event.status).toBe('DRAFT');
      expect(event.title).not.toBe('');
    });

    it('keep the computed end time consistent with an overridden start time', async () => {
      const startsAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      const event = await createEvent({ startsAt });

      expect(event.startsAt.toISOString()).toBe(startsAt.toISOString());
      expect(event.endsAt.getTime()).toBeGreaterThan(startsAt.getTime());
    });

    it('give every attendee a distinct address', async () => {
      const attendees = await Promise.all([createAttendee(), createAttendee(), createAttendee()]);
      const emails = new Set(attendees.map((attendee) => attendee.email));

      expect(emails.size).toBe(3);
    });

    it('fill an event to a requested number of confirmed seats', async () => {
      const event = await createEvent({ capacity: 5 });
      const filled = await fillEvent(event.id, 3);

      expect(filled).toHaveLength(3);
      await expect(
        prisma.registration.count({ where: { eventId: event.id, status: 'CONFIRMED' } }),
      ).resolves.toBe(3);
    });

    it('round-trip a timestamp through timestamptz without losing the instant', async () => {
      const startsAt = new Date('2027-03-29T01:30:00.000Z');
      const event = await createEvent({ startsAt });

      const reloaded = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });

      expect(reloaded.startsAt.toISOString()).toBe(startsAt.toISOString());
    });

    it('create a registration linked to both of its parents', async () => {
      const event = await createEvent();
      const attendee = await createAttendee();
      const registration = await createRegistration({
        eventId: event.id,
        attendeeId: attendee.id,
      });

      const loaded = await prisma.registration.findUniqueOrThrow({
        where: { id: registration.id },
        include: { event: true, attendee: true },
      });

      expect(loaded.event.id).toBe(event.id);
      expect(loaded.attendee.id).toBe(attendee.id);
      expect(loaded.status).toBe('CONFIRMED');
    });
  });
});
