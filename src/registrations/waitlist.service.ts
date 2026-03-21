import { Injectable } from '@nestjs/common';

import type { Prisma, Registration } from '../generated/prisma/client';
import { seatsAvailable, selectForPromotion } from './policy/waitlist';

/**
 * Filling free seats from the front of the queue.
 *
 * Its own provider because two quite different actions need it and must do it
 * identically: giving up a confirmed seat, and raising an event's capacity.
 * Two copies of this would be two chances to get the ordering right in one
 * place and wrong in the other.
 */
@Injectable()
export class WaitlistService {
  /**
   * Promote as many from the queue as there are seats, in ticket order.
   *
   * **Must be called with the event row already locked**, inside the caller's
   * transaction. Everything it reads — the capacity, the confirmed count, the
   * queue — has to be consistent with everything it writes, and outside the
   * lock none of it is: two callers would read the same free seat and promote
   * the same person.
   *
   * It takes the transaction client rather than reaching for its own, which is
   * what makes that requirement visible in the signature instead of being a
   * comment somebody has to notice.
   */
  async promote(tx: Prisma.TransactionClient, eventId: string): Promise<Registration[]> {
    const event = await tx.event.findUniqueOrThrow({
      where: { id: eventId },
      select: { capacity: true },
    });

    const confirmedCount = await tx.registration.count({
      where: { eventId, status: 'CONFIRMED' },
    });

    const seats = seatsAvailable(event.capacity, confirmedCount);

    if (seats === 0) {
      return [];
    }

    const queue = await tx.registration.findMany({
      where: { eventId, status: 'WAITLISTED' },
      select: { id: true, waitlistPosition: true },
    });

    const chosen = selectForPromotion(queue, seats);
    const promoted: Registration[] = [];

    // Sequentially, not in parallel: they share one transaction on one
    // connection, so firing them together buys nothing but interleaving.
    for (const entry of chosen) {
      promoted.push(
        await tx.registration.update({
          where: { id: entry.id },
          data: { status: 'CONFIRMED', waitlistPosition: null },
        }),
      );
    }

    return promoted;
  }
}
