import {
  acceptsRegistrations,
  applyAction,
  canDelete,
  EVENT_ACTIONS,
  EVENT_STATUSES,
  EventAction,
  EventStatus,
  isEventStatus,
} from './event-status';

/**
 * The expected outcome of every status × action pair, written out in full.
 *
 * A table rather than a loop over the implementation's own transition map: a
 * test that derives its expectations from the code under test agrees with that
 * code by construction, including when the code is wrong.
 */
const EXPECTED: Record<EventStatus, Record<EventAction, EventStatus | false>> = {
  DRAFT: { publish: 'PUBLISHED', cancel: false },
  PUBLISHED: { publish: false, cancel: 'CANCELLED' },
  CANCELLED: { publish: false, cancel: false },
};

const pairs = EVENT_STATUSES.flatMap((status) =>
  EVENT_ACTIONS.map((action) => ({ status, action, expected: EXPECTED[status][action] })),
);

describe('the event status state machine', () => {
  it('covers every status and action pair', () => {
    // Guards the table above: adding a status or an action without extending
    // the expectations would otherwise silently shrink this suite.
    expect(pairs).toHaveLength(EVENT_STATUSES.length * EVENT_ACTIONS.length);
    expect(pairs).toHaveLength(6);
  });

  describe.each(pairs)('$status + $action', ({ status, action, expected }) => {
    if (expected === false) {
      it('is refused', () => {
        expect(applyAction(status, action).allowed).toBe(false);
      });

      it('gives a reason a caller can act on', () => {
        const outcome = applyAction(status, action);

        expect(outcome.allowed).toBe(false);
        if (!outcome.allowed) {
          // Not "Conflict". The point of the reason is that it says which rule
          // was broken and, where there is one, what to do instead.
          expect(outcome.reason.length).toBeGreaterThan(20);
          expect(outcome.reason).not.toMatch(/^Conflict$/i);
        }
      });
    } else {
      it(`moves the event to ${expected}`, () => {
        expect(applyAction(status, action)).toEqual({ allowed: true, to: expected });
      });
    }
  });

  describe('the decisions behind the refusals', () => {
    it('will not cancel a draft, and says to delete it instead', () => {
      const outcome = applyAction('DRAFT', 'cancel');

      expect(outcome.allowed).toBe(false);
      if (!outcome.allowed) {
        expect(outcome.reason).toMatch(/delete/);
      }
    });

    it('treats cancelled as terminal', () => {
      // Republishing an event people were told was cancelled would quietly
      // reinstate registrations they believe are gone.
      expect(applyAction('CANCELLED', 'publish').allowed).toBe(false);
      expect(applyAction('CANCELLED', 'cancel').allowed).toBe(false);
    });

    it('is idempotent about nothing: publishing twice is refused, not ignored', () => {
      // Silently succeeding would tell the caller their second publish did
      // something. It did not.
      expect(applyAction('PUBLISHED', 'publish').allowed).toBe(false);
    });
  });

  describe('canDelete', () => {
    it('allows deleting a draft', () => {
      expect(canDelete('DRAFT').allowed).toBe(true);
    });

    it.each(['PUBLISHED', 'CANCELLED'] as const)('refuses to delete a %s event', (status) => {
      const outcome = canDelete(status);

      expect(outcome.allowed).toBe(false);
      if ('reason' in outcome) {
        expect(outcome.reason).toMatch(/cancel|record/);
      }
    });

    it('explains that cancelling preserves the registrations', () => {
      const outcome = canDelete('PUBLISHED');

      expect(outcome.allowed).toBe(false);
      if ('reason' in outcome) {
        expect(outcome.reason).toMatch(/registrations/);
      }
    });
  });

  describe('acceptsRegistrations', () => {
    it.each(EVENT_STATUSES)('is only true for PUBLISHED (%s)', (status) => {
      expect(acceptsRegistrations(status)).toBe(status === 'PUBLISHED');
    });
  });

  describe('isEventStatus', () => {
    it.each(EVENT_STATUSES)('accepts %s', (status) => {
      expect(isEventStatus(status)).toBe(true);
    });

    it.each([['draft'], ['ARCHIVED'], [''], [null], [undefined], [7], [{}]])(
      'rejects %p',
      (value) => {
        expect(isEventStatus(value)).toBe(false);
      },
    );
  });
});
