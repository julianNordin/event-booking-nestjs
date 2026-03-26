/**
 * What /health answers with when everything it checks is up.
 *
 * Terminus ships a schema of its own through `@HealthCheck()`, but it comes
 * bundled with a 503 declared as `application/json` — and this API's 503 is a
 * problem+json document, because the global filter converts Terminus's
 * ServiceUnavailableException the same way it converts every other failure.
 * The two cannot be separated: `@nestjs/swagger` merges two declarations of one
 * status into a single entry, so Terminus's `schema` and the problem+json
 * `content` end up on the same response and the `schema` wins, whichever order
 * the decorators are written in. Turning its documentation off is the only lever
 * there is, and that means describing the success shape here.
 */
import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';

/** One dependency's verdict. */
export class HealthCheckEntryDto {
  @ApiProperty({
    description: 'Whether this dependency answered.',
    enum: ['up', 'down'],
    example: 'up',
  })
  status!: 'up' | 'down';

  @ApiPropertyOptional({
    description:
      'Why it did not, on a check that is down. A short token — a driver error code where ' +
      'there is one, an error class name otherwise. Never the driver message, which names ' +
      'hosts and ports and occasionally credentials.',
    example: 'P2010',
  })
  reason?: string;
}

const checkMap = {
  type: 'object',
  additionalProperties: { $ref: getSchemaPath(HealthCheckEntryDto) },
} as const;

@ApiExtraModels(HealthCheckEntryDto)
export class HealthResponseDto {
  @ApiProperty({
    description: 'The aggregate verdict.',
    enum: ['ok', 'error', 'shutting_down'],
    example: 'ok',
  })
  status!: string;

  @ApiProperty({
    description: 'The checks that are up, keyed by name.',
    ...checkMap,
    example: { database: { status: 'up' } },
  })
  info!: Record<string, HealthCheckEntryDto>;

  @ApiProperty({
    description: 'The checks that are down, keyed by name. Empty on a 200.',
    ...checkMap,
    example: {},
  })
  error!: Record<string, HealthCheckEntryDto>;

  @ApiProperty({
    description: 'Every check, up or down, keyed by name.',
    ...checkMap,
    example: { database: { status: 'up' } },
  })
  details!: Record<string, HealthCheckEntryDto>;
}
