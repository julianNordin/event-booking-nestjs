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

import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';

import {
  ApiProblemBadRequest,
  ApiProblemConflict,
  ApiProblemNotFound,
  ApiProblemTooManyRequests,
} from '../common/decorators/api-problem-response.decorator';

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
@ApiTags('attendees')
@Public()
@Controller('attendees')
export class AttendeesController {
  constructor(private readonly attendees: AttendeesService) {}

  // Unauthenticated and it creates rows, so it is rate limited for the same
  // reason registration is.
  @ApiOperation({
    summary: 'Create an attendee',
    description: 'Email is case-insensitively unique.',
  })
  @ApiCreatedResponse({
    type: AttendeeResponseDto,
    description: 'Created. See the Location header.',
  })
  @ApiProblemBadRequest()
  @ApiProblemConflict('That email address already exists, ignoring case.')
  @ApiProblemTooManyRequests()
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

  @ApiOperation({ summary: 'Read one attendee' })
  @ApiOkResponse({ type: AttendeeResponseDto, description: 'The attendee.' })
  @ApiProblemBadRequest('The id is not a version 7 uuid.')
  @ApiProblemNotFound()
  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
  ): Promise<AttendeeResponseDto> {
    return this.attendees.findOne(id);
  }

  @ApiOperation({
    summary: "An attendee's registrations",
    description: 'Newest first, cancellations included — they are the record of what happened.',
  })
  @ApiOkResponse({
    type: [RegistrationResponseDto],
    description: 'Every registration this person holds or has held.',
  })
  @ApiProblemNotFound('No attendee with that id.')
  @Get(':id/registrations')
  findRegistrations(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
  ): Promise<RegistrationResponseDto[]> {
    return this.attendees.findRegistrations(id);
  }
}
