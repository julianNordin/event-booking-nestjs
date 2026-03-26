import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckResult, HealthCheckService } from '@nestjs/terminus';

import { ApiProblemServiceUnavailable } from '../common/decorators/api-problem-response.decorator';
import { Public } from '../common/decorators/public.decorator';
import { PrismaHealthIndicator } from './prisma.health';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: PrismaHealthIndicator,
  ) {}

  /**
   * Public and unkeyed, deliberately.
   *
   * A load balancer, an orchestrator and an uptime monitor all need to reach
   * this, and none of them can be given an organiser's key. That is also why
   * the response says whether the database answered and nothing whatsoever
   * about why it did not.
   *
   * Outside the /api/v1 prefix: it reports on the process, not on the API, and
   * it should not need changing when the API is versioned.
   */
  @ApiOperation({
    summary: 'Liveness and readiness',
    description: 'Reports whether the database is answering. 503 when it is not.',
  })
  @ApiOkResponse({ description: 'Everything checked is up.' })
  @ApiProblemServiceUnavailable('Something checked is down; the service is not ready for traffic.')
  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([() => this.database.pingCheck('database')]);
  }
}
