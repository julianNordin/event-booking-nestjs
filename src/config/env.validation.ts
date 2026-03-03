import { plainToInstance, Type } from 'class-transformer';
import { IsEnum, IsInt, IsString, Matches, Max, Min, validateSync } from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/**
 * The complete set of environment variables this service reads.
 *
 * Everything the application needs is declared here with a type and a rule. A
 * variable that is missing or malformed stops the process during bootstrap,
 * where it is one line of output, rather than surfacing an hour later as a 500
 * from whichever request happened to touch it first.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  /**
   * Deliberately stricter than `@IsUrl()`, which rejects `postgresql://` hosts
   * like `db` or `localhost` and accepts an `https://` string that could never
   * open a connection.
   */
  @IsString()
  @Matches(/^postgres(ql)?:\/\/\S+$/, {
    message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
  })
  DATABASE_URL!: string;

  /**
   * Upper bound on the pg connection pool. Sized deliberately rather than left
   * to a default: the registration path holds an interactive transaction open
   * across a row lock, and a pool smaller than the concurrency under test turns
   * a capacity failure into a pool-exhaustion failure that looks the same from
   * the outside.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  DATABASE_POOL_MAX = 10;
}

export class EnvironmentValidationError extends Error {
  constructor(readonly failures: string[]) {
    super(
      `Invalid environment. The process cannot start:\n` +
        failures.map((f) => `  - ${f}`).join('\n'),
    );
    this.name = 'EnvironmentValidationError';
  }
}

/**
 * Pure and idempotent: same input, same output, no I/O and no cached state.
 *
 * That matters because it is called both as `ConfigModule`'s `validate` hook and
 * again inside each `registerAs` factory. Calling it twice costs microseconds
 * and removes any dependence on the order in which `ConfigModule` evaluates its
 * `validate` hook relative to its `load` factories.
 */
export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  // `@Type(() => Number)` on each numeric field rather than
  // `enableImplicitConversion`: process.env values are always strings, and an
  // explicit converter says which fields are numbers at the point of
  // declaration instead of relying on reflected metadata being present.
  const parsed = plainToInstance(EnvironmentVariables, raw, {
    exposeDefaultValues: true,
  });

  const errors = validateSync(parsed, {
    skipMissingProperties: false,
    forbidUnknownValues: true,
  });

  if (errors.length > 0) {
    const failures = errors.flatMap((error) => Object.values(error.constraints ?? {}));
    throw new EnvironmentValidationError(failures);
  }

  return parsed;
}
