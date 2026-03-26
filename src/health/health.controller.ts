import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckResult, HealthCheckService } from '@nestjs/terminus';

import { ApiProblemServiceUnavailable } from '../common/decorators/api-problem-response.decorator';
import { DependencyUnavailableError } from '../common/errors/domain-error';
import { Public } from '../common/decorators/public.decorator';
import { HealthResponseDto } from './dto/health-response.dto';
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
   *
   * `swaggerDocumentation: false` because Terminus declares its 503 as
   * `application/json`, and this API's 503 is problem+json — see
   * HealthResponseDto for why the two cannot coexist. `noCache` has to be
   * repeated with it: the option object replaces the defaults wholesale, so
   * passing one key alone silently drops the Cache-Control header, and a cached
   * health check reports the state the service was in when somebody else asked.
   */
  @ApiOperation({
    summary: 'Liveness and readiness',
    description: 'Reports whether the database is answering. 503 when it is not.',
  })
  @ApiOkResponse({ description: 'Everything checked is up.', type: HealthResponseDto })
  @ApiProblemServiceUnavailable(
    'Something checked is down; the service is not ready for traffic. `failing` names each ' +
      'check that is down and `checks` carries what every check reported.',
  )
  @Get()
  @HealthCheck({ noCache: true, swaggerDocumentation: false })
  async check(): Promise<HealthCheckResult> {
    try {
      return await this.health.check([() => this.database.pingCheck('database')]);
    } catch (error) {
      throw asDomainError(error);
    }
  }
}

/**
 * Terminus reports a failed check by throwing a ServiceUnavailableException
 * whose payload is the whole HealthCheckResult. The global filter renders any
 * HttpException by its message, and that message is the de-camelcased class
 * name — so the body read `"detail": "Service Unavailable Exception"` and said
 * nothing at all about which dependency was down. The one fact this endpoint
 * exists to convey was reaching the logs and not the response.
 *
 * Translating here rather than teaching the filter about Terminus keeps
 * `common/` free of it: this module already depends on Terminus, and the HTTP
 * boundary is the right place to turn one framework's exception into this
 * API's own vocabulary.
 */
function asDomainError(error: unknown): unknown {
  if (!(error instanceof ServiceUnavailableException)) {
    return error;
  }

  const result = error.getResponse() as Partial<HealthCheckResult>;
  const checks = result.details ?? result.error ?? {};
  const failing = Object.entries(checks)
    .filter(([, check]) => check?.status !== 'up')
    .map(([name]) => name);

  return new DependencyUnavailableError(failing, checks);
}
