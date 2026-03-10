import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { EventResponseDto } from './dto/event-response.dto';
import { toEventResponse } from './event.mapper';

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
}
