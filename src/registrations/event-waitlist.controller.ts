import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';

import {
  ApiProblemNotFound,
  ApiProblemUnauthorized,
} from '../common/decorators/api-problem-response.decorator';
import { ORGANISER_KEY_SCHEME } from '../openapi';
import { WaitlistEntryDto } from './dto/waitlist-entry.dto';
import { RegistrationsService } from './registrations.service';

/**
 * The queue for an event, as its own resource.
 *
 * Separate from the event's registrations because it answers a different
 * question. The roster is everyone ever attached to the event, cancellations
 * included; the waitlist is only the people still waiting, in the order they
 * will be served, and it is the one an organiser looks at before deciding
 * whether to find a bigger room.
 */
@ApiTags('registrations')
@Controller('events/:eventId/waitlist')
export class EventWaitlistController {
  constructor(private readonly registrations: RegistrationsService) {}

  @ApiOperation({
    summary: "An event's waitlist",
    description: 'Only those still waiting, in the order they will be served.',
  })
  @ApiSecurity(ORGANISER_KEY_SCHEME)
  @ApiOkResponse({ type: [WaitlistEntryDto], description: 'The queue, front first.' })
  @ApiProblemUnauthorized()
  @ApiProblemNotFound()
  @Get()
  findWaitlist(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
  ): Promise<WaitlistEntryDto[]> {
    return this.registrations.findWaitlist(eventId);
  }
}
