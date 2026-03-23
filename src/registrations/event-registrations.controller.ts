import {
  Body,
  Controller,
  UseGuards,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { ThrottlerGuard } from '@nestjs/throttler';

import { Public } from '../common/decorators/public.decorator';
import { GLOBAL_PREFIX } from '../config/app.config';
import { CreateRegistrationDto } from './dto/create-registration.dto';
import { RegistrationResponseDto } from './dto/registration-response.dto';
import { RegistrationsService } from './registrations.service';

/**
 * Registrations as a sub-resource of the event they belong to.
 *
 * The event is in the path rather than the body because it is not a property of
 * the request — it is what the request is *about*, and a body field would make
 * `POST /events/A/registrations {eventId: B}` a question with two answers.
 */
@Controller('events/:eventId/registrations')
export class EventRegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  /**
   * Signing up is the public action, so it is rate limited instead of keyed.
   *
   * Applied here rather than globally on purpose. Throttling every route would
   * also throttle an organiser's dashboard reloading a page, and the endpoint
   * worth protecting is the one an unauthenticated caller can hit in a loop.
   *
   * It is not a substitute for the capacity rule — the row lock is what stops
   * an event overbooking. This stops one caller consuming the whole queue's
   * worth of attempts before anybody else gets a look in.
   */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
    @Body() dto: CreateRegistrationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RegistrationResponseDto> {
    const registration = await this.registrations.register(eventId, dto);

    // Points at the registration's own resource, not back at the event: what
    // was created is the registration.
    response.setHeader('Location', `/${GLOBAL_PREFIX}/registrations/${registration.id}`);

    return registration;
  }

  /**
   * Organiser only, deliberately. The roster names every attendee on an event,
   * which is the organiser's data and nobody else's.
   */
  @Get()
  findAll(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
  ): Promise<RegistrationResponseDto[]> {
    return this.registrations.findForEvent(eventId);
  }
}
