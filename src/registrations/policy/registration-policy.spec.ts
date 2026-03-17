import { EVENT_STATUSES, EventStatus } from '../../events/event-status';
import {
  decideRegistration,
  RegistrationContext,
  REGISTRATION_REFUSALS,
} from './registration-policy';

const NOW = new Date('2027-06-01T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function context(
  overrides: {
    event?: Partial<RegistrationContext['event']>;
    now?: Date;
    confirmedCount?: number;
  } = {},
): RegistrationContext {
  return {
    now: overrides.now ?? NOW,
    confirmedCount: overrides.confirmedCount ?? 0,
    event: {
      status: 'PUBLISHED',
      capacity: 10,
      waitlistEnabled: true,
      startsAt: new Date(NOW.getTime() + 30 * DAY),
      registrationOpensAt: null,
      registrationClosesAt: null,
      ...overrides.event,
    },
  };
}

describe('decideRegistration', () => {
  it('confirms a seat at a published event with room', () => {
    expect(decideRegistration(context())).toEqual({ outcome: 'CONFIRMED' });
  });

  describe('the event status', () => {
    it.each(EVENT_STATUSES)('handles %s', (status: EventStatus) => {
      const decision = decideRegistration(context({ event: { status } }));

      expect(decision.outcome).toBe(status === 'PUBLISHED' ? 'CONFIRMED' : 'REFUSED');
    });

    it('says a cancelled event is cancelled, not merely unpublished', () => {
      // Two different facts for the person reading it: one may become bookable
      // later, the other never will.
      const decision = decideRegistration(context({ event: { status: 'CANCELLED' } }));

      expect(decision).toMatchObject({ outcome: 'REFUSED', reason: 'event-cancelled' });
    });

    it('reports a draft as not yet open', () => {
      const decision = decideRegistration(context({ event: { status: 'DRAFT' } }));

      expect(decision).toMatchObject({ outcome: 'REFUSED', reason: 'event-not-published' });
    });
  });

  describe('the registration window', () => {
    it('refuses before it opens', () => {
      const decision = decideRegistration(
        context({ event: { registrationOpensAt: new Date(NOW.getTime() + DAY) } }),
      );

      expect(decision).toMatchObject({ reason: 'registration-not-open' });
    });

    it('accepts at the exact instant it opens', () => {
      expect(decideRegistration(context({ event: { registrationOpensAt: NOW } })).outcome).toBe(
        'CONFIRMED',
      );
    });

    it('refuses after it closes', () => {
      const decision = decideRegistration(
        context({ event: { registrationClosesAt: new Date(NOW.getTime() - 1) } }),
      );

      expect(decision).toMatchObject({ reason: 'registration-closed' });
    });

    it('accepts at the exact instant it closes', () => {
      // Inclusive: a deadline of noon means noon is still in time.
      expect(decideRegistration(context({ event: { registrationClosesAt: NOW } })).outcome).toBe(
        'CONFIRMED',
      );
    });

    it('ignores an absent window entirely', () => {
      expect(
        decideRegistration(
          context({ event: { registrationOpensAt: null, registrationClosesAt: null } }),
        ).outcome,
      ).toBe('CONFIRMED');
    });
  });

  describe('an event that has begun', () => {
    it('is refused even with no close time set', () => {
      // Without this check an event with no explicit deadline stays bookable
      // while it is happening, and after it has finished.
      const decision = decideRegistration(
        context({ event: { startsAt: new Date(NOW.getTime() - HOUR) } }),
      );

      expect(decision).toMatchObject({ reason: 'event-already-started' });
    });

    it('is refused at the exact instant it starts', () => {
      const decision = decideRegistration(context({ event: { startsAt: NOW } }));

      expect(decision).toMatchObject({ reason: 'event-already-started' });
    });

    it('is accepted one millisecond before it starts', () => {
      const decision = decideRegistration(
        context({ event: { startsAt: new Date(NOW.getTime() + 1) } }),
      );

      expect(decision.outcome).toBe('CONFIRMED');
    });
  });

  describe('capacity', () => {
    it('confirms while there is room', () => {
      expect(decideRegistration(context({ confirmedCount: 9, event: { capacity: 10 } }))).toEqual({
        outcome: 'CONFIRMED',
      });
    });

    it('waitlists once the last seat is taken', () => {
      expect(decideRegistration(context({ confirmedCount: 10, event: { capacity: 10 } }))).toEqual({
        outcome: 'WAITLISTED',
      });
    });

    it('waitlists an already overbooked event rather than confirming', () => {
      // Defensive: if a count ever exceeds capacity, the answer must not be to
      // sell another seat.
      expect(
        decideRegistration(context({ confirmedCount: 12, event: { capacity: 10 } })).outcome,
      ).toBe('WAITLISTED');
    });

    it('refuses when full and the waitlist is off', () => {
      const decision = decideRegistration(
        context({ confirmedCount: 10, event: { capacity: 10, waitlistEnabled: false } }),
      );

      expect(decision).toMatchObject({ reason: 'event-full' });
    });

    it('confirms at a one-seat event that is still empty', () => {
      // The setup for the concurrency phase: exactly one of these may win.
      expect(
        decideRegistration(context({ confirmedCount: 0, event: { capacity: 1 } })).outcome,
      ).toBe('CONFIRMED');
    });

    it('waitlists at a one-seat event that is taken', () => {
      expect(
        decideRegistration(context({ confirmedCount: 1, event: { capacity: 1 } })).outcome,
      ).toBe('WAITLISTED');
    });
  });

  describe('the order the rules are applied in', () => {
    // Each of these breaks more than one rule at once. Reordering the checks
    // would not change whether the caller is refused, but it would change what
    // they are told — and the first true refusal is the most useful one.
    it('reports a cancelled full event as cancelled', () => {
      const decision = decideRegistration(
        context({
          confirmedCount: 10,
          event: { status: 'CANCELLED', capacity: 10, waitlistEnabled: false },
        }),
      );

      expect(decision).toMatchObject({ reason: 'event-cancelled' });
    });

    it('reports an unopened, already-full event as not yet open', () => {
      const decision = decideRegistration(
        context({
          confirmedCount: 10,
          event: {
            capacity: 10,
            waitlistEnabled: false,
            registrationOpensAt: new Date(NOW.getTime() + DAY),
          },
        }),
      );

      expect(decision).toMatchObject({ reason: 'registration-not-open' });
    });

    it('reports a closed, already-started event as closed', () => {
      const decision = decideRegistration(
        context({
          event: {
            registrationClosesAt: new Date(NOW.getTime() - DAY),
            startsAt: new Date(NOW.getTime() - HOUR),
          },
        }),
      );

      expect(decision).toMatchObject({ reason: 'registration-closed' });
    });
  });

  describe('every refusal', () => {
    it('carries a message that says what is wrong', () => {
      const reasons = new Set<string>();

      const decisions = [
        decideRegistration(context({ event: { status: 'CANCELLED' } })),
        decideRegistration(context({ event: { status: 'DRAFT' } })),
        decideRegistration(
          context({ event: { registrationOpensAt: new Date(NOW.getTime() + DAY) } }),
        ),
        decideRegistration(
          context({ event: { registrationClosesAt: new Date(NOW.getTime() - DAY) } }),
        ),
        decideRegistration(context({ event: { startsAt: new Date(NOW.getTime() - HOUR) } })),
        decideRegistration(
          context({ confirmedCount: 1, event: { capacity: 1, waitlistEnabled: false } }),
        ),
      ];

      for (const decision of decisions) {
        expect(decision.outcome).toBe('REFUSED');
        if (decision.outcome === 'REFUSED') {
          expect(decision.message.length).toBeGreaterThan(15);
          reasons.add(decision.reason);
        }
      }

      // Every declared refusal is reachable. One that is not is either dead
      // code or a rule nobody wrote a path to.
      expect(reasons).toEqual(new Set(REGISTRATION_REFUSALS));
    });
  });
});
