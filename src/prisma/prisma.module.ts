import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * Global because every feature module needs the same single client, and one
 * connection pool is the point. Importing PrismaModule per feature would still
 * share the provider, but @Global states the intent and keeps the pool from
 * being accidentally re-provided in a child injector.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
