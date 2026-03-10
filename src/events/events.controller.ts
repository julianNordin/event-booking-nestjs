import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

import { EventResponseDto } from './dto/event-response.dto';
import { EventsService } from './events.service';

/**
 * HTTP only. No Prisma import, no rules, no transactions — the controller's
 * entire job is to turn a request into a service call and a DTO into a
 * response, which is what keeps the service independently testable.
 */
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  findAll(): Promise<EventResponseDto[]> {
    return this.events.findAll();
  }

  @Get(':id')
  findOne(
    // version 7 specifically, because that is what this schema generates.
    // Left unversioned, a v4 id from some other system would pass the pipe and
    // reach the database as a guaranteed miss dressed up as a valid request.
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
  ): Promise<EventResponseDto> {
    return this.events.findOne(id);
  }
}
