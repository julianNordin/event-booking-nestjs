import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto';
import { EventResponseDto } from './dto/event-response.dto';
import { toEventResponse } from './event.mapper';
import { EventSchedule, validateSchedule } from './event-schedule';

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
      throw new NotFoundException(`No event with id ${id}`);
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
      throw new BadRequestException({
        message: violations.map((violation) => `${violation.field}: ${violation.message}`),
        errors: violations,
      });
    }
  }
}
