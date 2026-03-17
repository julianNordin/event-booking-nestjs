import { EventStatus } from '../../events/event-status';

/**
 * Whether someone may register, decided as a pure function.
 *
 * No Nest, no Prisma, no clock, no I/O — the caller supplies the event, the
 * instant, and how many seats are already taken, and gets back a decision.
 * That is what lets every branch below be covered exhaustively in
 * milliseconds, and it is why the most important rules in this service need no
 * database to be verified.
 *
 * It also means the service layer has exactly one job on the write path:
 * gather those three inputs, and carry out the decision.
 */
export interface RegistrationContext {
  event: {
    status: EventStatus;
    capacity: number;
    waitlistEnabled: boolean;
    startsAt: Date;
    registrationOpensAt: Date | null;
    registrationClosesAt: Date | null;
  };
  now: Date;
  /** How many CONFIRMED registrations the event already holds. */
  confirmedCount: number;
}

export const REGISTRATION_REFUSALS = [
  'event-not-published',
  'event-cancelled',
  'registration-not-open',
  'registration-closed',
  'event-already-started',
  'event-full',
] as const;

export type RegistrationRefusal = (typeof REGISTRATION_REFUSALS)[number];

export type RegistrationDecision =
  | { readonly outcome: 'CONFIRMED' }
  | { readonly outcome: 'WAITLISTED' }
  | { readonly outcome: 'REFUSED'; readonly reason: RegistrationRefusal; readonly message: string };

const REFUSAL_MESSAGES: Record<RegistrationRefusal, string> = {
  'event-not-published': 'this event is not open for registration yet',
  'event-cancelled': 'this event has been cancelled',
  'registration-not-open': 'registration for this event has not opened yet',
  'registration-closed': 'registration for this event has closed',
  'event-already-started': 'this event has already started',
  'event-full': 'this event is full and has no waitlist',
};

function refuse(reason: RegistrationRefusal): RegistrationDecision {
  return { outcome: 'REFUSED', reason, message: REFUSAL_MESSAGES[reason] };
}

/**
 * The order of these checks is deliberate and is itself tested.
 *
 * A cancelled event must be reported as cancelled rather than as full, and an
 * event whose registration has closed must say so rather than complaining that
 * it started — the first true refusal is the most useful one, and reordering
 * them changes what a caller is told without changing whether they are refused.
 */
export function decideRegistration(context: RegistrationContext): RegistrationDecision {
  const { event, now, confirmedCount } = context;

  if (event.status === 'CANCELLED') {
    return refuse('event-cancelled');
  }

  if (event.status !== 'PUBLISHED') {
    return refuse('event-not-published');
  }

  if (event.registrationOpensAt !== null && now.getTime() < event.registrationOpensAt.getTime()) {
    return refuse('registration-not-open');
  }

  if (event.registrationClosesAt !== null && now.getTime() > event.registrationClosesAt.getTime()) {
    return refuse('registration-closed');
  }

  // Checked even when there is no explicit close time. An event with the doors
  // already open is not accepting bookings, and leaving this out would let
  // someone register for something happening now — or last week.
  if (now.getTime() >= event.startsAt.getTime()) {
    return refuse('event-already-started');
  }

  // The comparison the whole project is about. Under concurrency this is a
  // check-then-act: two callers can both read the same count, both find room,
  // and both be told CONFIRMED. Deciding it here is correct — the decision is
  // a pure function of its inputs — and it is the *caller's* job to make sure
  // the count it passes cannot go stale between reading and writing.
  if (confirmedCount < event.capacity) {
    return { outcome: 'CONFIRMED' };
  }

  if (event.waitlistEnabled) {
    return { outcome: 'WAITLISTED' };
  }

  return refuse('event-full');
}
