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
      // A short token, never the driver's own message: a connection error
      // carries a host, a port and sometimes a password, and /health is the
      // most reliably unauthenticated endpoint on any service.
      return check.down({ reason: reasonFor(error) });
    }
  }
}

/**
 * The shortest safe description of why the ping failed.
 *
 * Prefers the driver's code, because one outage produces three different error
 * shapes depending on what the pool happened to be doing: a connection torn
 * down mid-flight is a bare `Error` with no code at all, the first query
 * through a pool the database dropped carries `P2010`, and a fresh connect once
 * the pool has drained carries `ECONNREFUSED`. All three were seen inside a
 * single `docker compose stop db`. Going by `name` alone reported the literal
 * word "Error" for one of them, which is worth nothing in an alert.
 */
function reasonFor(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown';
  }

  const { code } = error as { code?: unknown };

  return typeof code === 'string' && code !== '' ? code : error.name;
}
