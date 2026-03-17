import { Injectable } from '@nestjs/common';

import { Clock } from '../common/clock/clock.service';
import {
  ResourceNotFoundError,
  RuleViolationError,
  TransitionNotAllowedError,
} from '../common/errors/domain-error';
import type { Registration as PrismaRegistration } from '../generated/prisma/client';
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
   * Register someone for an event.
   *
   * **This implementation overbooks under concurrency, and that is deliberate
   * for now.** Counting the confirmed registrations and then inserting is a
   * check-then-act on shared state: under READ COMMITTED two requests both read
   * the same count, both find room, and both insert. The next phase writes the
   * test that proves it, then closes it with a row lock. Fixing it here would
   * mean shipping a lock whose necessity was never demonstrated.
   */
  async register(eventId: string, dto: CreateRegistrationDto): Promise<RegistrationResponseDto> {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });

    if (event === null) {
      throw new ResourceNotFoundError('event', eventId);
    }

    // Checked explicitly rather than left to the foreign key. The constraint
    // would refuse the insert too, but as a 409 about a relationship; a person
    // who does not exist is a 404 about the person.
    const attendee = await this.prisma.attendee.findUnique({ where: { id: dto.attendeeId } });

    if (attendee === null) {
      throw new ResourceNotFoundError('attendee', dto.attendeeId);
    }

    const confirmedCount = await this.prisma.registration.count({
      where: { eventId, status: 'CONFIRMED' },
    });

    const decision = decideRegistration({ event, now: this.clock.now(), confirmedCount });

    if (decision.outcome === 'REFUSED') {
      throw new RuleViolationError(decision.message, decision.reason, {
        eventId,
        attendeeId: dto.attendeeId,
      });
    }

    const registration = await this.prisma.registration.create({
      data: {
        eventId,
        attendeeId: dto.attendeeId,
        status: decision.outcome,
        waitlistPosition:
          decision.outcome === 'WAITLISTED' ? await this.nextWaitlistPosition(eventId) : null,
      },
    });

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
   */
  private async nextWaitlistPosition(eventId: string): Promise<number> {
    const highest = await this.prisma.registration.aggregate({
      where: { eventId, status: 'WAITLISTED' },
      _max: { waitlistPosition: true },
    });

    return (highest._max.waitlistPosition ?? 0) + 1;
  }
}
