import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { API_KEY_HEADER } from '../../src/config/security.config';
import { configureApp } from '../../src/configure-app';

/**
 * The whole application, bootstrapped the way production bootstraps it.
 *
 * `AppModule` unmodified and `configureApp` unmodified — the same function
 * `main.ts` calls, so the global validation pipe, the exception filter, the
 * logging interceptor, the API key guard and the URL prefix are all the real
 * ones. An end-to-end suite that assembles its own application and skips the
 * global pipe passes on payloads the real service rejects, and the gap is
 * invisible until production.
 *
 * The only thing not done here is `listen()`: supertest binds the server to an
 * ephemeral port itself, so nothing needs a fixed one.
 */
export interface TestApp {
  app: INestApplication;
  server: Server;
}

export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = configureApp(moduleRef.createNestApplication());
  await app.init();

  return { app, server: app.getHttpServer() as Server };
}

/** The keys global setup publishes. Real ones as far as the running app knows. */
export const ORGANISER_KEY = 'sk_test_stockholm';
export const OTHER_ORGANISER_KEY = 'sk_test_malmo';

export { API_KEY_HEADER };
