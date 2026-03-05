import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
// A type-only import, because ConfigType appears in a decorated constructor
// signature and isolatedModules + emitDecoratorMetadata reject a value import
// there. Safe precisely because it is a type alias: the DI token is the
// explicit databaseConfig.KEY below, not reflected class metadata.
import type { ConfigType } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';

import { databaseConfig } from '../config/database.config';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(
    @Inject(databaseConfig.KEY)
    database: ConfigType<typeof databaseConfig>,
  ) {
    super({
      // Prisma 7 dropped the Rust query engine, so a driver adapter is how the
      // client reaches the database at all — it is not an opt-in optimisation.
      //
      // The connection string arrives through the injected, validated config.
      // Reading process.env here instead would evaluate at module load, before
      // ConfigModule has run its validator, and the resulting failure surfaces
      // as an adapter error that reads exactly like a Nest DI problem.
      adapter: new PrismaPg({
        connectionString: database.url,
        max: database.poolMax,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('database connection pool opened');
  }

  async onModuleDestroy(): Promise<void> {
    // Reached only because configureApp calls enableShutdownHooks(). Without
    // that, SIGTERM never gets here and every container restart abandons the
    // pool instead of draining it.
    await this.$disconnect();
    this.logger.log('database connection pool closed');
  }
}
