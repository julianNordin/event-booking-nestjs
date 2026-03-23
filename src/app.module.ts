import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_GUARD } from '@nestjs/core';

import { AttendeesModule } from './attendees/attendees.module';
import { ClockModule } from './common/clock/clock.module';
import { appConfig } from './config/app.config';
import { databaseConfig } from './config/database.config';
import { securityConfig } from './config/security.config';
import { ApiKeyGuard } from './common/guards/api-key.guard';
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
      load: [appConfig, databaseConfig, securityConfig],
      validate: validateEnv,
    }),
    EventEmitterModule.forRoot(),
    ClockModule,
    PrismaModule,
    EventsModule,
    AttendeesModule,
    RegistrationsModule,
  ],
  controllers: [],
  providers: [
    // Global and fail-closed: every route needs a key unless it is marked
    // @Public(). A new endpoint added without thinking about auth is therefore
    // unreachable rather than unprotected.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class AppModule {}
