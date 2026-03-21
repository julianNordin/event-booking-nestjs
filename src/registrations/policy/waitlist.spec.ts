import { inQueueOrder, seatsAvailable, selectForPromotion, WaitlistEntry } from './waitlist';

const entry = (id: string, waitlistPosition: number | null): WaitlistEntry => ({
  id,
  waitlistPosition,
});

describe('seatsAvailable', () => {
  it.each([
    [10, 3, 7],
    [10, 10, 0],
    [1, 0, 1],
  ])('capacity %i with %i confirmed leaves %i', (capacity, confirmed, expected) => {
    expect(seatsAvailable(capacity, confirmed)).toBe(expected);
  });

  it('never reports a negative number of seats', () => {
    // An overbooked event has no seats free; it does not have minus two.
    // Returning a negative would make selectForPromotion's slice behave very
    // strangely indeed.
    expect(seatsAvailable(5, 8)).toBe(0);
  });
});

describe('inQueueOrder', () => {
  it('serves the lowest ticket first', () => {
    const ordered = inQueueOrder([entry('c', 3), entry('a', 1), entry('b', 2)]);

    expect(ordered.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('is unaffected by gaps left behind by earlier promotions', () => {
    // Tickets are never renumbered, so a queue that has been served for a while
    // looks like this. Order is what matters, not contiguity.
    const ordered = inQueueOrder([entry('c', 9), entry('a', 4), entry('b', 7)]);

    expect(ordered.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a tie deterministically rather than arbitrarily', () => {
    const first = inQueueOrder([entry('b', 1), entry('a', 1)]);
    const second = inQueueOrder([entry('a', 1), entry('b', 1)]);

    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
  });

  it('sorts an unticketed entry last, never first', () => {
    // It should not happen, but a null must not jump a queue it never joined.
    const ordered = inQueueOrder([entry('x', null), entry('a', 5)]);

    expect(ordered.map((item) => item.id)).toEqual(['a', 'x']);
  });

  it('does not mutate the array it was given', () => {
    const queue = [entry('c', 3), entry('a', 1)];

    inQueueOrder(queue);

    expect(queue.map((item) => item.id)).toEqual(['c', 'a']);
  });
});

describe('selectForPromotion', () => {
  const queue = [entry('a', 1), entry('b', 2), entry('c', 3)];

  it('promotes nobody when there are no seats', () => {
    expect(selectForPromotion(queue, 0)).toEqual([]);
  });

  it('promotes nobody when the seat count is somehow negative', () => {
    expect(selectForPromotion(queue, -3)).toEqual([]);
  });

  it('promotes the front of the queue when one seat opens', () => {
    expect(selectForPromotion(queue, 1).map((item) => item.id)).toEqual(['a']);
  });

  it('promotes in order when several seats open at once', () => {
    // Raising capacity by two must take the first two, not any two.
    expect(selectForPromotion(queue, 2).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('promotes everybody and stops when the queue is shorter than the seats', () => {
    expect(selectForPromotion(queue, 10).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('promotes nobody from an empty queue', () => {
    expect(selectForPromotion([], 5)).toEqual([]);
  });
});
