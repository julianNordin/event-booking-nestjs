import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
// Type-only: it appears in a decorated signature, and @Res() is what tells Nest
// what to inject, not the reflected metadata.
import type { Response } from 'express';

import { GLOBAL_PREFIX } from '../config/app.config';
import { CreateEventDto } from './dto/create-event.dto';

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

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateEventDto,
    // passthrough: true keeps Nest in charge of serialising the body. Without
    // it, taking the response object makes the handler responsible for sending
    // everything, and the returned DTO is silently never written.
    @Res({ passthrough: true }) response: Response,
  ): Promise<EventResponseDto> {
    const event = await this.events.create(dto);

    // 201 without a Location header tells the client something was created and
    // refuses to say where.
    response.setHeader('Location', `/${GLOBAL_PREFIX}/events/${event.id}`);

    return event;
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
