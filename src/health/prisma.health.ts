import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Is the database actually answering?
 *
 * `SELECT 1` through the same client the application serves requests with — not
 * a fresh connection opened for the check. A health endpoint that dials the
 * database independently reports "up" while the pool the service uses is
 * exhausted or broken, which is the one failure it most needs to catch.
 *
 * It is also the cheapest query there is: a health check runs on a timer, and
 * one that costs real work becomes load of its own.
 */
@Injectable()
export class PrismaHealthIndicator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    const check = this.indicator.check(key);

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return check.up();
    } catch (error) {
      // The reason is reported, but only the name of it. A connection error
      // carries a host, a port and sometimes a password, and /health is the
      // most reliably unauthenticated endpoint on any service.
      return check.down({
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}
