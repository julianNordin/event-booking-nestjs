import { captureViolation } from '../support/expect-violation';
import { createAttendee, createEvent, createRegistration, fillEvent } from '../support/factories';
import { testPrisma } from '../support/prisma';

const prisma = testPrisma();

/**
 * The two relations are deliberately asymmetric, and the asymmetry is the whole
 * point: one side may be swept away with its parent, the other may not be swept
 * away silently at all.
 */
describe('delete behaviour', () => {
  describe('deleting an event', () => {
    it('takes its registrations with it', async () => {
      const event = await createEvent({ capacity: 5 });
      await fillEvent(event.id, 3);

      await prisma.event.delete({ where: { id: event.id } });

      await expect(prisma.registration.count()).resolves.toBe(0);
    });

    it('leaves the attendees alone', async () => {
      // A registration is meaningless without its event. A person is not.
      const event = await createEvent({ capacity: 5 });
      await fillEvent(event.id, 3);

      await prisma.event.delete({ where: { id: event.id } });

      await expect(prisma.attendee.count()).resolves.toBe(3);
    });

    it('leaves other events untouched', async () => {
      const [doomed, survivor] = await Promise.all([createEvent(), createEvent()]);
      await fillEvent(doomed.id, 2);
      await fillEvent(survivor.id, 2);

      await prisma.event.delete({ where: { id: doomed.id } });

      await expect(prisma.event.count()).resolves.toBe(1);
      await expect(prisma.registration.count({ where: { eventId: survivor.id } })).resolves.toBe(2);
    });
  });

  describe('deleting an attendee', () => {
    it('is refused while they hold a registration', async () => {
      // RESTRICT, not CASCADE. The cascading alternative removes someone from
      // the roster of every event they signed up for and tells nobody, and the
      // organiser finds out by counting heads at the door.
      const event = await createEvent();
      const attendee = await createAttendee();
      await createRegistration({ eventId: event.id, attendeeId: attendee.id });

      const violation = await captureViolation(() =>
        prisma.attendee.delete({ where: { id: attendee.id } }),
      );

      expect(violation.code).toBe('P2003');
      expect(violation.sqlState).toBe('23001');
      expect(violation.constraint).toBe('registrations_attendee_id_fkey');
    });

    it('is refused even when every registration is cancelled', async () => {
      // The foreign key does not read status. That is correct: the cancelled
      // rows are the audit trail of who was signed up and changed their mind,
      // and deleting the person would erase it.
      const event = await createEvent();
      const attendee = await createAttendee();
      const registration = await createRegistration({
        eventId: event.id,
        attendeeId: attendee.id,
      });
      await prisma.registration.update({
        where: { id: registration.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      const violation = await captureViolation(() =>
        prisma.attendee.delete({ where: { id: attendee.id } }),
      );

      expect(violation.code).toBe('P2003');
    });

    it('succeeds once nothing references them', async () => {
      const attendee = await createAttendee();

      await expect(prisma.attendee.delete({ where: { id: attendee.id } })).resolves.toBeDefined();
      await expect(prisma.attendee.count()).resolves.toBe(0);
    });

    it('succeeds after the event they registered for is deleted', async () => {
      // Deleting the event cascades the registration away, which removes the
      // reference and unblocks the attendee.
      const event = await createEvent();
      const attendee = await createAttendee();
      await createRegistration({ eventId: event.id, attendeeId: attendee.id });

      await prisma.event.delete({ where: { id: event.id } });

      await expect(prisma.attendee.delete({ where: { id: attendee.id } })).resolves.toBeDefined();
    });
  });

  describe('deleting a registration', () => {
    it('leaves both of its parents in place', async () => {
      const event = await createEvent();
      const attendee = await createAttendee();
      const registration = await createRegistration({
        eventId: event.id,
        attendeeId: attendee.id,
      });

      await prisma.registration.delete({ where: { id: registration.id } });

      await expect(prisma.event.count()).resolves.toBe(1);
      await expect(prisma.attendee.count()).resolves.toBe(1);
    });
  });
});
