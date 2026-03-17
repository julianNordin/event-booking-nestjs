import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

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
}
