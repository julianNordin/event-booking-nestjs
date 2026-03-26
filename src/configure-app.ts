import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { ValidationError } from 'class-validator';

import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ValidationFailedError } from './common/errors/domain-error';
import { toFieldErrors } from './common/errors/validation-errors';

import { GLOBAL_PREFIX } from './config/app.config';
import { setupOpenApi } from './openapi';

/**
 * Everything that turns a bare Nest application into *this* application.
 *
 * It lives in its own module rather than inside `bootstrap()` for one reason:
 * the end-to-end tier has to exercise the same pipes, filters and prefix that
 * production runs. A suite that calls `NestFactory.create` and skips the global
 * ValidationPipe is testing a different application, and it goes green on
 * payloads the real service would reject.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix(GLOBAL_PREFIX);

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip anything not declared on the DTO...
      whitelist: true,
      // ...and refuse the request outright rather than silently discarding it,
      // so a client that misspells a field is told, instead of watching the
      // value vanish.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        // Off on purpose. Implicit conversion turns `?capacity=abc` into NaN
        // and hands it to the validator as a number; each DTO says what it
        // converts with an explicit @Type, the way the env schema does.
        enableImplicitConversion: false,
      },
      // Nest's default turns the validation tree into an array of sentences,
      // which is readable and not actionable: a form cannot highlight a field
      // it has to find by parsing prose. Raising a domain error instead means
      // the same filter renders it, with a per-field list a client can use.
      exceptionFactory: (errors: ValidationError[]) =>
        new ValidationFailedError(toFieldErrors(errors)),
    }),
  );

  // Before the filter, so a failed request still gets its id assigned and
  // echoed — the trace is most wanted precisely when something went wrong.
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Registered through HttpAdapterHost rather than by grabbing the Express
  // response, so it works on whichever adapter the app is running on.
  app.useGlobalFilters(new ProblemDetailsFilter(app.get(HttpAdapterHost)));

  // Mounted here rather than in main.ts so the end-to-end tier documents the
  // same application it tests — a spec generated from a different assembly is
  // a spec for a different API.
  setupOpenApi(app);

  // Nest only forwards SIGTERM and friends to onModuleDestroy/onApplicationShutdown
  // once this is called. Without it a container restart drops the connection
  // pool on the floor instead of draining it.
  app.enableShutdownHooks();

  return app;
}
