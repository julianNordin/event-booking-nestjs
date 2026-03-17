import { Module } from '@nestjs/common';

import { EventRegistrationsController } from './event-registrations.controller';
import { RegistrationsService } from './registrations.service';

@Module({
  controllers: [EventRegistrationsController],
  providers: [RegistrationsService],
  exports: [RegistrationsService],
})
export class RegistrationsModule {}
