import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AttendeesModule } from './attendees/attendees.module';
import { appConfig } from './config/app.config';
import { databaseConfig } from './config/database.config';
import { validateEnv } from './config/env.validation';
import { EventsModule } from './events/events.module';
import { PrismaModule } from './prisma/prisma.module';

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
    PrismaModule,
    EventsModule,
    AttendeesModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
