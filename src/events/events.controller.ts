import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
// Type-only: it appears in a decorated signature, and @Res() is what tells Nest
// what to inject, not the reflected metadata.
import type { Response } from 'express';

import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';

import {
  ApiProblemBadRequest,
  ApiProblemConflict,
  ApiProblemNotFound,
  ApiProblemUnauthorized,
} from '../common/decorators/api-problem-response.decorator';
import { Organiser } from '../common/decorators/organiser.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { OrganiserIdentity } from '../config/security.config';
import { GLOBAL_PREFIX } from '../config/app.config';
import { CreateEventDto } from './dto/create-event.dto';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { PagedEventsDto } from './dto/paged-events.dto';
import { ORGANISER_KEY_SCHEME } from '../openapi';
import { UpdateEventDto } from './dto/update-event.dto';

import { PagedResponse } from '../common/dto/paged-response';
import { EventResponseDto } from './dto/event-response.dto';
import { EventsService } from './events.service';

/**
 * HTTP only. No Prisma import, no rules, no transactions — the controller's
 * entire job is to turn a request into a service call and a DTO into a
 * response, which is what keeps the service independently testable.
 */
@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  // Browsing what is on is the point of a public events API.
  @Public()
  @ApiOperation({ summary: 'List events', description: 'Paged, filterable and searchable.' })
  @ApiOkResponse({ type: PagedEventsDto, description: 'One page of events.' })
  @ApiProblemBadRequest('An unknown query parameter, or a sort field that is not whitelisted.')
  @Get()
  findAll(@Query() query: ListEventsQueryDto): Promise<PagedResponse<EventResponseDto>> {
    return this.events.findAll(query);
  }

  @ApiOperation({
    summary: 'Create an event',
    description: 'Always created as a DRAFT. Status changes go through publish and cancel.',
  })
  @ApiSecurity(ORGANISER_KEY_SCHEME)
  @ApiCreatedResponse({ type: EventResponseDto, description: 'Created. See the Location header.' })
  @ApiProblemBadRequest()
  @ApiProblemUnauthorized()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateEventDto,
    @Organiser() organiser: OrganiserIdentity,
    // passthrough: true keeps Nest in charge of serialising the body. Without
    // it, taking the response object makes the handler responsible for sending
    // everything, and the returned DTO is silently never written.
    @Res({ passthrough: true }) response: Response,
  ): Promise<EventResponseDto> {
    const event = await this.events.create(dto, organiser);

    // 201 without a Location header tells the client something was created and
    // refuses to say where.
    response.setHeader('Location', `/${GLOBAL_PREFIX}/events/${event.id}`);

    return event;
  }

  @Public()
  @ApiOperation({ summary: 'Read one event' })
  @ApiOkResponse({ type: EventResponseDto, description: 'The event.' })
  @ApiProblemBadRequest('The id is not a version 7 uuid.')
  @ApiProblemNotFound('No event with that id.')
  @Get(':id')
  findOne(
    // version 7 specifically, because that is what this schema generates.
    // Left unversioned, a v4 id from some other system would pass the pipe and
    // reach the database as a guaranteed miss dressed up as a valid request.
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
  ): Promise<EventResponseDto> {
    return this.events.findOne(id);
  }

  @ApiOperation({ summary: 'Edit an event', description: 'Absent fields are left alone.' })
  @ApiSecurity(ORGANISER_KEY_SCHEME)
  @ApiOkResponse({ type: EventResponseDto, description: 'The event as it now stands.' })
  @ApiProblemBadRequest()
  @ApiProblemUnauthorized()
  @ApiProblemNotFound()
  @ApiProblemConflict('The event is cancelled, or capacity would drop below the confirmed count.')
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: UpdateEventDto,
    @Organiser() organiser: OrganiserIdentity,
  ): Promise<EventResponseDto> {
    return this.events.update(id, dto, organiser);
  }

  // Publish and cancel are POSTs to named sub-resources rather than a PATCH of
  // the status field. They are not field assignments — each one runs a rule
  // that can refuse, and cancelling additionally cancels every registration.
  // A verb the client can name is honest about that; PATCH { status } is not.
  @ApiOperation({ summary: 'Publish a draft event' })
  @ApiSecurity(ORGANISER_KEY_SCHEME)
  @ApiOkResponse({ type: EventResponseDto, description: 'The event, now PUBLISHED.' })
  @ApiProblemUnauthorized()
  @ApiProblemNotFound()
  @ApiProblemConflict('Already published, or cancelled and therefore terminal.')
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  publish(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Organiser() organiser: OrganiserIdentity,
  ): Promise<EventResponseDto> {
    return this.events.publish(id, organiser);
  }

  @ApiOperation({
    summary: 'Cancel an event',
    description: 'Cancels every active registration with it, in one transaction.',
  })
  @ApiSecurity(ORGANISER_KEY_SCHEME)
  @ApiOkResponse({ type: EventResponseDto, description: 'The event, now CANCELLED.' })
  @ApiProblemUnauthorized()
  @ApiProblemNotFound()
  @ApiProblemConflict('A draft has nothing to call off; already cancelled.')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Organiser() organiser: OrganiserIdentity,
  ): Promise<EventResponseDto> {
    return this.events.cancel(id, organiser);
  }

  @ApiOperation({ summary: 'Delete a draft event', description: 'Drafts only.' })
  @ApiSecurity(ORGANISER_KEY_SCHEME)
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiProblemUnauthorized()
  @ApiProblemNotFound()
  @ApiProblemConflict('Published and cancelled events are kept; cancel rather than delete.')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Organiser() organiser: OrganiserIdentity,
  ): Promise<void> {
    return this.events.remove(id, organiser);
  }
}
