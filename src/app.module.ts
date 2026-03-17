import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AttendeesModule } from './attendees/attendees.module';
import { ClockModule } from './common/clock/clock.module';
import { appConfig } from './config/app.config';
import { databaseConfig } from './config/database.config';
import { validateEnv } from './config/env.validation';
import { EventsModule } from './events/events.module';
import { PrismaModule } from './prisma/prisma.module';
import { RegistrationsModule } from './registrations/registrations.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Read once at boot. Nothing in this service reacts to the environment
      // changing underneath it, and a cached lookup keeps ConfigService off the
      // hot path of every request.
      cache: true,
      expandVariables: true,
      load: [appConfig, databaseConfig],
      validate: validateEnv,
    }),
    ClockModule,
    PrismaModule,
    EventsModule,
    AttendeesModule,
    RegistrationsModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
