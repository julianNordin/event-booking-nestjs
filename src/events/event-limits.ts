/**
 * The declared width of every text column on `events`, in one place.
 *
 * The DTO validators read these, and an integration test reads
 * `information_schema` and asserts the database agrees. That is the point: a
 * column widened in a migration without widening the validator gives a 400 for
 * a value the database would have accepted, and a validator widened without the
 * migration turns a clear 400 into a driver error at insert time. Neither is
 * discoverable by reading one file.
 */
export const EVENT_LIMITS = {
  title: 200,
  description: 2000,
  venue: 200,
} as const;

/**
 * An upper bound on capacity that the database does not impose.
 *
 * `capacity >= 1` is a CHECK constraint; there is no maximum in SQL because
 * there is no correct one. This bound exists so an obvious typo — six digits
 * where two were meant — is refused at the boundary rather than becoming an
 * event that can never sell out.
 */
export const MAX_CAPACITY = 1_000_000;
