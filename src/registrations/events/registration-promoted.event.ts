/**
 * The event name, as a constant.
 *
 * "registration.promoted", not "event.promoted" — this project has two things
 * called an event, the domain object and the emitter's messages, and keeping
 * the emitter's vocabulary explicit is the only thing that stops that
 * collision becoming confusing in every file that mentions either.
 */
export const REGISTRATION_PROMOTED = 'registration.promoted';

/**
 * Somebody moved off the waitlist and now holds a seat.
 *
 * Emitted **after** the transaction that promoted them has committed, never
 * inside it. A listener that sends an email from inside the transaction sends
 * it whether or not the transaction survives, and a promotion that rolls back
 * has still told somebody they got in.
 *
 * The listener here only logs. The point of the seam is that a mailer, a
 * webhook or a push notification is a new listener rather than a new branch in
 * the registration service — and none of them can hold the event's row lock
 * open while they talk to something slow.
 */
export class RegistrationPromotedEvent {
  constructor(
    readonly registrationId: string,
    readonly eventId: string,
    readonly attendeeId: string,
    readonly promotedAt: Date,
  ) {}
}
