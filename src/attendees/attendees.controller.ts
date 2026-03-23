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
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { ThrottlerGuard } from '@nestjs/throttler';

import { Public } from '../common/decorators/public.decorator';
import { GLOBAL_PREFIX } from '../config/app.config';
import { RegistrationResponseDto } from '../registrations/dto/registration-response.dto';
import { AttendeesService } from './attendees.service';
import { AttendeeResponseDto } from './dto/attendee-response.dto';
import { CreateAttendeeDto } from './dto/create-attendee.dto';

/**
 * Public in its entirety. This API has one identity — the organiser — and
 * everything an attendee does is unauthenticated by design; see the README on
 * what that means and what a real deployment would put in front of it.
 */
@Public()
@Controller('attendees')
export class AttendeesController {
  constructor(private readonly attendees: AttendeesService) {}

  // Unauthenticated and it creates rows, so it is rate limited for the same
  // reason registration is.
  @UseGuards(ThrottlerGuard)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateAttendeeDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AttendeeResponseDto> {
    const attendee = await this.attendees.create(dto);

    response.setHeader('Location', `/${GLOBAL_PREFIX}/attendees/${attendee.id}`);

    return attendee;
  }

  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
  ): Promise<AttendeeResponseDto> {
    return this.attendees.findOne(id);
  }

  @Get(':id/registrations')
  findRegistrations(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
  ): Promise<RegistrationResponseDto[]> {
    return this.attendees.findRegistrations(id);
  }
}
