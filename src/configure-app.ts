import { INestApplication, ValidationPipe } from '@nestjs/common';

import { GLOBAL_PREFIX } from './config/app.config';

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
    }),
  );

  // Nest only forwards SIGTERM and friends to onModuleDestroy/onApplicationShutdown
  // once this is called. Without it a container restart drops the connection
  // pool on the floor instead of draining it.
  app.enableShutdownHooks();

  return app;
}
