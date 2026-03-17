import { Module } from '@nestjs/common';

import { EventRegistrationsController } from './event-registrations.controller';
import { RegistrationsController } from './registrations.controller';
import { RegistrationsService } from './registrations.service';

@Module({
  controllers: [EventRegistrationsController, RegistrationsController],
  providers: [RegistrationsService],
  exports: [RegistrationsService],
})
export class RegistrationsModule {}
