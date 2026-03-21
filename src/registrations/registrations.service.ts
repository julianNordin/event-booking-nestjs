import { Injectable, Logger } from '@nestjs/common';

import { Clock } from '../common/clock/clock.service';
import {
  ResourceNotFoundError,
  RuleViolationError,
  TransitionNotAllowedError,
} from '../common/errors/domain-error';
import type { Prisma, Registration as PrismaRegistration } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRegistrationDto } from './dto/create-registration.dto';
import { RegistrationResponseDto } from './dto/registration-response.dto';
import { WaitlistEntryDto } from './dto/waitlist-entry.dto';
import { decideRegistration } from './policy/registration-policy';
import { WaitlistService } from './waitlist.service';
import { toRegistrationResponse } from './registration.mapper';

@Injectable()
export class RegistrationsService {
  private readonly logger = new Logger(RegistrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly waitlist: WaitlistService,
  ) {}

  /**
   * How long a registration may wait for a connection, and how long it may hold
   * the transaction open once it has one.
   *
   * Both are stated rather than left to Prisma's defaults (2s and 5s), because
   * this is the one path in the service that deliberately serialises: with a
   * queue of contenders behind one row lock, the last one in line waits for
   * everyone ahead of it. Too short and a busy event starts refusing people for
   * a reason that has nothing to do with capacity — and the suite goes green
   * while doing it, which is the failure this phase exists to avoid.
   */
  private static readonly TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 10_000 };

  /**
   * Register someone for an event, without overbooking it.
   *
   * The naive version of this counted the confirmed registrations and then
   * inserted. That is a check-then-act on shared state, and under READ
   * COMMITTED every concurrent request reads the same count, every one finds
   * room, and every one inserts. Measured on this schema: twenty simultaneous
   * requests for a **one-seat** event produced **twenty confirmed
   * registrations**. Not a near miss — no serialisation at all.
   *
   * The fix is one line of SQL that Prisma's client API cannot express:
   *
   *     SELECT id FROM events WHERE id = $1 FOR UPDATE
   *
   * Taken inside the transaction and *before* the count, it makes every
   * registration for this event queue behind the one in front. The lock is on
   * the event row, so it serialises exactly the thing that must be serialised
   * and nothing else: a rush on one event does not delay another by a
   * microsecond, and there is a test for that.
   *
   * Two alternatives were considered and rejected — see the README section
   * "Why a row lock" for the reasoning: a denormalised counter on `events`
   * (two sources of truth that drift, and the drift is silent), and
   * SERIALIZABLE with a retry loop (correct, but it converts contention into
   * 40001 serialisation failures and every client has to know how to retry).
   */
  async register(eventId: string, dto: CreateRegistrationDto): Promise<RegistrationResponseDto> {
    // Outside the transaction on purpose: whether this person exists has
    // nothing to do with the capacity race, and doing it here keeps the
    // critical section as short as it can be.
    const attendee = await this.prisma.attendee.findUnique({
      where: { id: dto.attendeeId },
      select: { id: true },
    });

    if (attendee === null) {
      throw new ResourceNotFoundError('attendee', dto.attendeeId);
    }

    const registration = await this.prisma.$transaction(async (tx) => {
      // The lock, first. Everything after this runs with the event row held,
      // so the count below cannot go stale before the insert.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM events WHERE id = ${eventId}::uuid FOR UPDATE
      `;

      if (locked.length === 0) {
        throw new ResourceNotFoundError('event', eventId);
      }

      const event = await tx.event.findUniqueOrThrow({ where: { id: eventId } });

      const confirmedCount = await tx.registration.count({
        where: { eventId, status: 'CONFIRMED' },
      });

      const decision = decideRegistration({ event, now: this.clock.now(), confirmedCount });

      if (decision.outcome === 'REFUSED') {
        throw new RuleViolationError(decision.message, decision.reason, {
          eventId,
          attendeeId: dto.attendeeId,
        });
      }

      return tx.registration.create({
        data: {
          eventId,
          attendeeId: dto.attendeeId,
          status: decision.outcome,
          waitlistPosition:
            decision.outcome === 'WAITLISTED' ? await this.nextWaitlistPosition(tx, eventId) : null,
        },
      });
    }, RegistrationsService.TRANSACTION_OPTIONS);

    return toRegistrationResponse(registration);
  }

  /**
   * Everyone attached to an event, in the order a door list wants them:
   * confirmed seats first, then the queue in position order, then the people
   * who cancelled.
   *
   * That ordering is free — the RegistrationStatus enum is declared
   * CONFIRMED, WAITLISTED, CANCELLED, and PostgreSQL sorts an enum by its
   * declared order rather than alphabetically, which would have given
   * CANCELLED, CONFIRMED, WAITLISTED.
   */
  async findForEvent(eventId: string): Promise<RegistrationResponseDto[]> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true },
    });

    if (event === null) {
      throw new ResourceNotFoundError('event', eventId);
    }

    const registrations = await this.prisma.registration.findMany({
      where: { eventId },
      orderBy: [
        { status: 'asc' },
        { waitlistPosition: { sort: 'asc', nulls: 'last' } },
        { registeredAt: 'asc' },
        { id: 'asc' },
      ],
    });

    return registrations.map(toRegistrationResponse);
  }

  /**
   * The queue for an event: only the people still waiting, in the order they
   * will be served.
   *
   * Distinct from the roster, which includes confirmed seats and cancellations.
   * This is the list an organiser reads before deciding whether to find a
   * bigger room.
   */
  async findWaitlist(eventId: string): Promise<WaitlistEntryDto[]> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true },
    });

    if (event === null) {
      throw new ResourceNotFoundError('event', eventId);
    }

    const queue = await this.prisma.registration.findMany({
      where: { eventId, status: 'WAITLISTED' },
      orderBy: [{ waitlistPosition: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    });

    return queue.map((registration, index) => ({
      // Derived from the position in this ordered list, not from the stored
      // ticket. The two differ as soon as anybody ahead has left, and it is
      // the place people actually want to know.
      place: index + 1,
      waitlistPosition: registration.waitlistPosition ?? 0,
      registrationId: registration.id,
      attendeeId: registration.attendeeId,
      registeredAt: registration.registeredAt.toISOString(),
    }));
  }

  async findOne(id: string): Promise<RegistrationResponseDto> {
    return toRegistrationResponse(await this.requireRegistration(id));
  }

  /**
   * Give up a seat or a place in the queue, and let the next person in.
   *
   * Cancelling and promoting are one transaction under the event's row lock —
   * the same lock registration takes. That is not tidiness, it is the whole
   * correctness argument:
   *
   * - Without it, two cancellations at an event with two people queued both
   *   read one free seat, both pick the front of the queue, and promote the
   *   *same* person twice. The second person stays waiting while a seat sits
   *   empty, and nothing errors.
   * - Cancelling first and promoting after would leave a window in which the
   *   seat is free and the queue is not being served, so a registration
   *   arriving in between takes a seat that was owed to somebody in the queue.
   *
   * The registration is re-read *inside* the lock. Its status may have changed
   * between the lookup that told us which event to lock and the lock being
   * granted, and that re-read is what makes a double cancellation refuse rather
   * than promote twice.
   */
  async cancel(id: string): Promise<RegistrationResponseDto> {
    // Read once outside the transaction, only to learn which event row to lock.
    // Nothing is decided on this copy.
    const subject = await this.requireRegistration(id);

    const { cancelled, promoted } = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM events WHERE id = ${subject.eventId}::uuid FOR UPDATE
      `;

      if (locked.length === 0) {
        throw new ResourceNotFoundError('event', subject.eventId);
      }

      const registration = await tx.registration.findUniqueOrThrow({ where: { id } });

      if (registration.status === 'CANCELLED') {
        throw new TransitionNotAllowedError(
          'this registration has already been cancelled',
          registration.status,
          'cancel',
        );
      }

      const cancelledRow = await tx.registration.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: this.clock.now(),
          // Vacating the ticket as well as the status. A cancelled row that
          // keeps its number still claims a place in a queue it has left.
          waitlistPosition: null,
        },
      });

      // Only a confirmed seat frees a seat. Leaving the queue frees nothing,
      // and promoting on a waitlist cancellation would confirm someone the
      // event has no room for.
      if (registration.status !== 'CONFIRMED') {
        return { cancelled: cancelledRow, promoted: [] };
      }

      return {
        cancelled: cancelledRow,
        promoted: await this.waitlist.promote(tx, subject.eventId),
      };
    }, RegistrationsService.TRANSACTION_OPTIONS);

    for (const registration of promoted) {
      this.logger.log(
        `promoted registration ${registration.id} to CONFIRMED for event ${subject.eventId}`,
      );
    }

    return toRegistrationResponse(cancelled);
  }

  private async requireRegistration(id: string): Promise<PrismaRegistration> {
    const registration = await this.prisma.registration.findUnique({ where: { id } });

    if (registration === null) {
      throw new ResourceNotFoundError('registration', id);
    }

    return registration;
  }

  /**
   * One past the highest position currently held.
   *
   * Derived rather than counted: counting the waitlisted rows would re-use a
   * position as soon as somebody in the middle of the queue cancelled, and two
   * people would then hold the same place.
   *
   * Runs on the transaction client, under the same row lock as the decision
   * above. Read outside it, two concurrent registrations would see the same
   * maximum and be handed the same position — the capacity race again, one
   * layer along.
   */
  private async nextWaitlistPosition(
    tx: Prisma.TransactionClient,
    eventId: string,
  ): Promise<number> {
    const highest = await tx.registration.aggregate({
      where: { eventId, status: 'WAITLISTED' },
      _max: { waitlistPosition: true },
    });

    return (highest._max.waitlistPosition ?? 0) + 1;
  }
}
