import { Injectable } from '@nestjs/common';

import {
  ResourceNotFoundError,
  RuleViolationError,
  TransitionNotAllowedError,
  ValidationFailedError,
} from '../common/errors/domain-error';
import type { Event as PrismaEvent } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto';
import { EventResponseDto } from './dto/event-response.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { toEventResponse } from './event.mapper';
import { EventSchedule, validateSchedule } from './event-schedule';
import { applyAction, canDelete, EventAction } from './event-status';

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<EventResponseDto[]> {
    const events = await this.prisma.event.findMany({
      // Soonest first, then by id. The second key is not decoration: startsAt
      // is not unique, and without a tiebreak PostgreSQL may return equal rows
      // in any order it likes — which is invisible until this list is paged and
      // a row starts appearing on two pages or none.
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });

    return events.map(toEventResponse);
  }

  async findOne(id: string): Promise<EventResponseDto> {
    const event = await this.prisma.event.findUnique({ where: { id } });

    if (event === null) {
      throw new ResourceNotFoundError('event', id);
    }

    return toEventResponse(event);
  }

  async create(dto: CreateEventDto): Promise<EventResponseDto> {
    this.assertScheduleIsCoherent(dto);

    const event = await this.prisma.event.create({
      // Written out field by field rather than spread. The DTO is shaped by the
      // wire contract and the row by the schema; they agree today, and a
      // spread would let tomorrow's divergence through silently.
      data: {
        title: dto.title,
        description: dto.description ?? null,
        venue: dto.venue,
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
        capacity: dto.capacity,
        waitlistEnabled: dto.waitlistEnabled ?? true,
        registrationOpensAt: dto.registrationOpensAt ?? null,
        registrationClosesAt: dto.registrationClosesAt ?? null,
        // status is not settable. Every event starts as a draft and leaves only
        // through the state machine.
      },
    });

    return toEventResponse(event);
  }

  async update(id: string, dto: UpdateEventDto): Promise<EventResponseDto> {
    const existing = await this.requireEvent(id);

    if (existing.status === 'CANCELLED') {
      // Terminal in the state machine, and terminal here too. A cancelled
      // event is the record of something that was called off; editing it
      // rewrites what attendees were told.
      throw new TransitionNotAllowedError(
        'a cancelled event is the record of something called off and cannot be edited',
        'CANCELLED',
        'update',
      );
    }

    // The schedule rules apply to the event as it will be, not to the fields
    // that happen to be in this request. Patching only endsAt has to be checked
    // against the stored startsAt, or an event can be walked into an invalid
    // state one field at a time.
    this.assertScheduleIsCoherent({
      startsAt: dto.startsAt ?? existing.startsAt,
      endsAt: dto.endsAt ?? existing.endsAt,
      registrationOpensAt:
        dto.registrationOpensAt === undefined
          ? existing.registrationOpensAt
          : dto.registrationOpensAt,
      registrationClosesAt:
        dto.registrationClosesAt === undefined
          ? existing.registrationClosesAt
          : dto.registrationClosesAt,
    });

    if (dto.capacity !== undefined && dto.capacity < existing.capacity) {
      await this.assertCapacityCoversConfirmed(id, dto.capacity);
    }

    const updated = await this.prisma.event.update({
      where: { id },
      // undefined means "leave this column alone" to Prisma and null means "set
      // it to null", which is exactly the distinction PATCH needs: an absent
      // field is untouched, an explicit null clears it.
      data: {
        title: dto.title,
        description: dto.description,
        venue: dto.venue,
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
        capacity: dto.capacity,
        waitlistEnabled: dto.waitlistEnabled,
        registrationOpensAt: dto.registrationOpensAt,
        registrationClosesAt: dto.registrationClosesAt,
      },
    });

    return toEventResponse(updated);
  }

  /**
   * Capacity may not be cut below the number of people already holding a seat.
   *
   * Allowing it would leave an event overbooked by construction, with no way to
   * decide which confirmed attendee loses their place.
   *
   * This is a read followed by a write, so under concurrency it is advisory:
   * a registration could land between the count and the update. That race is
   * the small one — reducing capacity is a rare administrative act — and the
   * authoritative protection lives on the registration path, which takes a row
   * lock on the event.
   */
  private async assertCapacityCoversConfirmed(eventId: string, capacity: number): Promise<void> {
    const confirmed = await this.prisma.registration.count({
      where: { eventId, status: 'CONFIRMED' },
    });

    if (capacity < confirmed) {
      throw new RuleViolationError(
        `capacity cannot be reduced to ${String(capacity)}: ${String(confirmed)} attendees already hold a confirmed seat`,
        'capacity-covers-confirmed',
        { requested: capacity, confirmed },
      );
    }
  }

  publish(id: string): Promise<EventResponseDto> {
    return this.runAction(id, 'publish');
  }

  cancel(id: string): Promise<EventResponseDto> {
    return this.runAction(id, 'cancel');
  }

  async remove(id: string): Promise<void> {
    const existing = await this.requireEvent(id);
    const outcome = canDelete(existing.status);

    if (!outcome.allowed) {
      throw new TransitionNotAllowedError(outcome.reason, existing.status, 'delete');
    }

    await this.prisma.event.delete({ where: { id } });
  }

  /**
   * Runs one transition of the state machine.
   *
   * The decision itself is the pure `applyAction`; everything here is the I/O
   * around it. That separation is what lets every status and action pair be
   * covered without a database, leaving these tests to cover only the parts
   * that genuinely need one.
   */
  private async runAction(id: string, action: EventAction): Promise<EventResponseDto> {
    const existing = await this.requireEvent(id);
    const outcome = applyAction(existing.status, action);

    if (!outcome.allowed) {
      throw new TransitionNotAllowedError(outcome.reason, existing.status, action);
    }

    if (outcome.to !== 'CANCELLED') {
      const updated = await this.prisma.event.update({
        where: { id },
        data: { status: outcome.to },
      });

      return toEventResponse(updated);
    }

    // Cancelling an event cancels everyone's place in it, and the two must
    // happen together. Cancelling the event alone leaves rows that claim to be
    // confirmed seats at something that is not running; cancelling the
    // registrations alone loses the event's own status if the second write
    // fails. One transaction, or neither.
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.registration.updateMany({
        where: { eventId: id, status: { in: ['CONFIRMED', 'WAITLISTED'] } },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          // The queue is gone with the event; leaving positions behind would
          // have them re-used if the rows were ever revived.
          waitlistPosition: null,
        },
      });

      return tx.event.update({ where: { id }, data: { status: 'CANCELLED' } });
    });

    return toEventResponse(updated);
  }

  private async requireEvent(id: string): Promise<PrismaEvent> {
    const event = await this.prisma.event.findUnique({ where: { id } });

    if (event === null) {
      throw new ResourceNotFoundError('event', id);
    }

    return event;
  }

  /**
   * Turns schedule violations into a 400 that names each offending field.
   *
   * endsAt > startsAt is also a CHECK constraint. Reaching the database and
   * letting it refuse would be correct but useless to the caller: the driver
   * error names a constraint, not a field, and carries the entire failing row.
   */
  private assertScheduleIsCoherent(schedule: EventSchedule): void {
    const violations = validateSchedule(schedule);

    if (violations.length > 0) {
      throw new ValidationFailedError(violations);
    }
  }
}
