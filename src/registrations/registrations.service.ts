import { Injectable } from '@nestjs/common';

import { Clock } from '../common/clock/clock.service';
import { ResourceNotFoundError, RuleViolationError } from '../common/errors/domain-error';
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
