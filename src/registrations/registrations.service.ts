import { Injectable } from '@nestjs/common';

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
import { decideRegistration } from './policy/registration-policy';
import { toRegistrationResponse } from './registration.mapper';

@Injectable()
export class RegistrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
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

  async findOne(id: string): Promise<RegistrationResponseDto> {
    return toRegistrationResponse(await this.requireRegistration(id));
  }

  /**
   * Give up a seat or a place in the queue.
   *
   * The row is kept and marked CANCELLED rather than deleted: it is the record
   * that this person did once hold a place, and the partial unique index is
   * written to ignore cancelled rows precisely so they can register again.
   *
   * Promoting whoever is next off the waitlist belongs here too, and does not
   * happen yet — that lands in the waitlist phase, inside this transaction.
   */
  async cancel(id: string): Promise<RegistrationResponseDto> {
    const registration = await this.requireRegistration(id);

    if (registration.status === 'CANCELLED') {
      throw new TransitionNotAllowedError(
        'this registration has already been cancelled',
        registration.status,
        'cancel',
      );
    }

    const cancelled = await this.prisma.registration.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: this.clock.now(),
        // Vacating the position as well as the status. Leaving it behind means
        // a cancelled row still claims a place in a queue it has left.
        waitlistPosition: null,
      },
    });

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
