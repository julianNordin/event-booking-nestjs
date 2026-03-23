import type { Server } from 'node:http';

import { Controller, Get, INestApplication, Post, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';

import { GLOBAL_PREFIX } from '../../config/app.config';
import { configureApp } from '../../configure-app';

const LIMIT = 3;

@Controller('probe')
class ProbeController {
  @UseGuards(ThrottlerGuard)
  @Post('limited')
  limited(): { ok: true } {
    return { ok: true };
  }

  /** No throttle guard: the organiser-facing routes are keyed, not rate limited. */
  @Get('unlimited')
  unlimited(): { ok: true } {
    return { ok: true };
  }
}

describe('throttling', () => {
  let app: INestApplication;
  let server: Server;

  // A fresh application per test, not per file. The throttler keeps its counter
  // in memory for the lifetime of the module, so a shared app would carry one
  // test's requests into the next and the limit would be spent before it began.
  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: LIMIT }])],
      controllers: [ProbeController],
    }).compile();

    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows requests up to the limit', async () => {
    for (let i = 0; i < LIMIT; i += 1) {
      await request(server).post(`/${GLOBAL_PREFIX}/probe/limited`).expect(201);
    }
  });

  it('refuses the one after that with 429', async () => {
    for (let i = 0; i < LIMIT; i += 1) {
      await request(server).post(`/${GLOBAL_PREFIX}/probe/limited`).expect(201);
    }

    await request(server).post(`/${GLOBAL_PREFIX}/probe/limited`).expect(429);
  });

  it('answers the refusal in the problem shape like everything else', async () => {
    // The throttler raises its own HttpException. Without the filter turning it
    // into problem+json, a client parsing this API would need a special case for
    // the one status it is most likely to meet under load.
    for (let i = 0; i < LIMIT; i += 1) {
      await request(server).post(`/${GLOBAL_PREFIX}/probe/limited`);
    }

    const response = await request(server).post(`/${GLOBAL_PREFIX}/probe/limited`).expect(429);

    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body).toMatchObject({
      type: 'urn:problem-type:event-booking:too-many-requests',
      status: 429,
    });
  });

  it('leaves unthrottled routes alone', async () => {
    // Throttling every route would also rate limit an organiser's dashboard
    // reloading a page. The endpoint worth protecting is the one an
    // unauthenticated caller can hit in a loop.
    for (let i = 0; i < LIMIT * 3; i += 1) {
      await request(server).get(`/${GLOBAL_PREFIX}/probe/unlimited`).expect(200);
    }
  });
});
