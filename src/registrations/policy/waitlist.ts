/**
 * Who moves up, and how many, decided as a pure function.
 *
 * As with the registration rules, no Nest, no Prisma and no clock — the caller
 * reads the queue under a lock and hands it here, and gets back the entries to
 * promote. Every ordering and boundary case below is settled without a
 * database.
 *
 * ## What a position means
 *
 * `waitlistPosition` is a **ticket**, issued once on joining the queue and
 * never rewritten. It is not a rank.
 *
 * Renumbering the queue whenever somebody leaves is what people expect, and it
 * was rejected: it turns one cancellation into an update of every row behind
 * it, under the same lock, and it makes two concurrent cancellations contend
 * over rows neither of them is about. Tickets only ever increase, gaps are
 * fine, and "where do I stand" is derived on read — which is the one place it
 * is cheap and cannot go stale.
 */
export interface WaitlistEntry {
  id: string;
  waitlistPosition: number | null;
}

/** How many confirmed seats are still free. Never negative, even if overbooked. */
export function seatsAvailable(capacity: number, confirmedCount: number): number {
  return Math.max(capacity - confirmedCount, 0);
}

/**
 * The queue in the order it should be served: lowest ticket first.
 *
 * A null ticket sorts last. It should not occur — the column is set whenever
 * the status is WAITLISTED — but ordering has to be total, and putting an
 * unticketed row at the front would let it jump a queue it never joined.
 */
export function inQueueOrder(entries: readonly WaitlistEntry[]): WaitlistEntry[] {
  return [...entries].sort((left, right) => {
    const a = left.waitlistPosition ?? Number.MAX_SAFE_INTEGER;
    const b = right.waitlistPosition ?? Number.MAX_SAFE_INTEGER;
    return a === b ? left.id.localeCompare(right.id) : a - b;
  });
}

/**
 * The entries that should be promoted, in the order they should be promoted.
 *
 * Returns fewer than `seats` when the queue is shorter, and nothing at all when
 * there are no seats — both of which are ordinary, not errors.
 */
export function selectForPromotion(
  entries: readonly WaitlistEntry[],
  seats: number,
): WaitlistEntry[] {
  if (seats <= 0) {
    return [];
  }

  return inQueueOrder(entries).slice(0, seats);
}
