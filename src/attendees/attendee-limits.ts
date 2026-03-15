/**
 * The declared width of every text column on `attendees`.
 *
 * As with events, an integration test reads `information_schema` and asserts
 * the database agrees with these, so the validator and the migration cannot
 * drift apart unnoticed.
 */
export const ATTENDEE_LIMITS = {
  /** RFC 5321: a 64-character local part, an @, and a domain of up to 255. */
  email: 320,
  name: 200,
} as const;
