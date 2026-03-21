import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

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
@Controller('events/:eventId/waitlist')
export class EventWaitlistController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Get()
  findWaitlist(
    @Param('eventId', new ParseUUIDPipe({ version: '7' })) eventId: string,
  ): Promise<WaitlistEntryDto[]> {
    return this.registrations.findWaitlist(eventId);
  }
}
