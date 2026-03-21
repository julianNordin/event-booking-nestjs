import { Module } from '@nestjs/common';

import { EventRegistrationsController } from './event-registrations.controller';
import { RegistrationsController } from './registrations.controller';
import { RegistrationsService } from './registrations.service';
import { WaitlistService } from './waitlist.service';

@Module({
  controllers: [EventRegistrationsController, RegistrationsController],
  providers: [RegistrationsService, WaitlistService],
  // WaitlistService is exported because raising an event's capacity has to
  // serve the queue too, and it must do it the same way cancelling does.
  exports: [RegistrationsService, WaitlistService],
})
export class RegistrationsModule {}
