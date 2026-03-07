import type {
  Attendee,
  Event,
  EventStatus,
  Registration,
  RegistrationStatus,
} from '../../src/generated/prisma/client';
import { testPrisma } from './prisma';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Every factory picks defaults that are *valid* and *uninteresting*, so a test
 * states only the one thing it is about. A test that reads
 * `createEvent({ capacity: 1 })` is visibly about capacity; the same test
 * spelling out a title, venue, both timestamps and a status buries that.
 *
 * Times are always relative to now. Fixed dates drift out of the future and
 * quietly change which branch of the registration rules a test exercises.
 */

let sequence = 0;

function nextSequence(): number {
  sequence += 1;
  return sequence;
}

export interface EventOverrides {
  title?: string;
  description?: string | null;
  venue?: string;
  startsAt?: Date;
  endsAt?: Date;
  capacity?: number;
  waitlistEnabled?: boolean;
  registrationOpensAt?: Date | null;
  registrationClosesAt?: Date | null;
  status?: EventStatus;
}

export async function createEvent(overrides: EventOverrides = {}): Promise<Event> {
  const startsAt = overrides.startsAt ?? new Date(Date.now() + 14 * DAY);

  return testPrisma().event.create({
    data: {
      title: `Event ${String(nextSequence())}`,
      venue: 'Norra Latin, Stockholm',
      capacity: 10,
      waitlistEnabled: true,
      status: 'PUBLISHED',
      ...overrides,
      startsAt,
      endsAt: overrides.endsAt ?? new Date(startsAt.getTime() + 8 * HOUR),
    },
  });
}

export interface AttendeeOverrides {
  email?: string;
  name?: string;
}

export async function createAttendee(overrides: AttendeeOverrides = {}): Promise<Attendee> {
  const n = nextSequence();

  return testPrisma().attendee.create({
    data: {
      // Unique by construction: the functional index on lower(email) is
      // case-insensitively unique, and a factory that collided would fail tests
      // for a reason that has nothing to do with what they assert.
      email: `attendee-${String(n)}@example.com`,
      name: `Attendee ${String(n)}`,
      ...overrides,
    },
  });
}

export interface RegistrationOverrides {
  eventId: string;
  attendeeId: string;
  status?: RegistrationStatus;
  waitlistPosition?: number | null;
  cancelledAt?: Date | null;
}

export async function createRegistration(overrides: RegistrationOverrides): Promise<Registration> {
  return testPrisma().registration.create({ data: { status: 'CONFIRMED', ...overrides } });
}

/** Fill an event to `count` confirmed seats, returning the attendees who hold them. */
export async function fillEvent(
  eventId: string,
  count: number,
): Promise<{ attendee: Attendee; registration: Registration }[]> {
  const filled: { attendee: Attendee; registration: Registration }[] = [];

  for (let i = 0; i < count; i += 1) {
    const attendee = await createAttendee();
    const registration = await createRegistration({ eventId, attendeeId: attendee.id });
    filled.push({ attendee, registration });
  }

  return filled;
}
