import { Module } from '@nestjs/common';

import { RegistrationsModule } from '../registrations/registrations.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [RegistrationsModule],
  controllers: [EventsController],
  providers: [EventsService],
  // Registrations will need to read and lock events; exporting the service
  // keeps that going through one place rather than a second set of queries.
  exports: [EventsService],
})
export class EventsModule {}
