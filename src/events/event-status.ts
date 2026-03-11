/**
 * The API's own vocabulary for an event's lifecycle, and the rules for moving
 * through it.
 *
 * Everything here is a pure function of its arguments: no Nest, no Prisma, no
 * clock, no I/O. That is what lets the whole state machine be tested over every
 * combination in milliseconds, and it is why the interesting rules of this
 * service do not need a database to be verified.
 *
 * The status enum is declared here rather than re-exported from the generated
 * client. The wire contract and the column type are two things that happen to
 * agree today; sharing the symbol would drag a Prisma import into every
 * controller and DTO that mentions a status.
 */
export const EVENT_STATUSES = ['DRAFT', 'PUBLISHED', 'CANCELLED'] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

export function isEventStatus(value: unknown): value is EventStatus {
  return typeof value === 'string' && (EVENT_STATUSES as readonly string[]).includes(value);
}

/** The transitions a client can ask for by name. */
export const EVENT_ACTIONS = ['publish', 'cancel'] as const;

export type EventAction = (typeof EVENT_ACTIONS)[number];

export type TransitionOutcome =
  | { readonly allowed: true; readonly to: EventStatus }
  | { readonly allowed: false; readonly reason: string };

/**
 * The full transition table, written out rather than inferred.
 *
 *            publish        cancel
 *   DRAFT    -> PUBLISHED   refused
 *   PUBLISHED  refused      -> CANCELLED
 *   CANCELLED  refused      refused
 *
 * Two refusals are deliberate design decisions rather than omissions.
 *
 * A draft cannot be cancelled: it was never announced, so there is nothing to
 * call off and nobody to tell. Deleting it is the operation that means what the
 * caller wants, and it is available precisely while an event is a draft.
 *
 * CANCELLED is terminal — it cannot be republished. Re-opening an event people
 * were already told was cancelled silently reinstates registrations that those
 * people believe are gone. Creating a new event is the honest way to do it.
 */
const TRANSITIONS: Readonly<
  Record<EventStatus, Readonly<Partial<Record<EventAction, EventStatus>>>>
> = {
  DRAFT: { publish: 'PUBLISHED' },
  PUBLISHED: { cancel: 'CANCELLED' },
  CANCELLED: {},
};

const REFUSALS: Readonly<Record<EventStatus, Readonly<Partial<Record<EventAction, string>>>>> = {
  DRAFT: {
    cancel: 'a draft event has never been announced; delete it instead of cancelling it',
  },
  PUBLISHED: {
    publish: 'this event is already published',
  },
  CANCELLED: {
    publish: 'a cancelled event cannot be republished; create a new event instead',
    cancel: 'this event is already cancelled',
  },
};

export function applyAction(from: EventStatus, action: EventAction): TransitionOutcome {
  const to = TRANSITIONS[from][action];

  if (to === undefined) {
    return {
      allowed: false,
      reason: REFUSALS[from][action] ?? `an event that is ${from} cannot be ${action}ed`,
    };
  }

  return { allowed: true, to };
}

/**
 * Deleting is allowed only while the event is a draft.
 *
 * Once published the event has been announced and may hold registrations, and
 * a delete would cascade them away without a trace. Cancelling keeps the record
 * and lets everyone concerned be told.
 */
export function canDelete(status: EventStatus): TransitionOutcome | { readonly allowed: true } {
  if (status === 'DRAFT') {
    return { allowed: true, to: 'DRAFT' };
  }

  return {
    allowed: false,
    reason:
      status === 'PUBLISHED'
        ? 'a published event cannot be deleted; cancel it so its registrations are preserved'
        : 'a cancelled event is kept as a record and cannot be deleted',
  };
}

/** Whether an event in this state accepts new registrations at all. */
export function acceptsRegistrations(status: EventStatus): boolean {
  return status === 'PUBLISHED';
}
