import type { Server } from 'node:http';

import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { GLOBAL_PREFIX } from '../../config/app.config';
import { API_KEY_HEADER, parseApiKeys, securityConfig } from '../../config/security.config';
import { configureApp } from '../../configure-app';
import { Organiser } from '../decorators/organiser.decorator';
import { Public } from '../decorators/public.decorator';
import { OrganiserIdentity } from '../../config/security.config';
import { ApiKeyGuard } from './api-key.guard';

const VALID_KEY = 'sk_test_stockholm';
const OTHER_KEY = 'sk_test_malmo';

const security = {
  organisersByKey: parseApiKeys(`stockholm-tech:${VALID_KEY},malmo-events:${OTHER_KEY}`),
  throttleLimit: 10,
  throttleTtlMs: 60_000,
};

@Controller('probe')
class ProbeController {
  /** No decorator: protected, because that is the default. */
  @Get('protected')
  protectedRoute(@Organiser() organiser: OrganiserIdentity | undefined): { by?: string } {
    return { by: organiser?.name };
  }

  @Public()
  @Get('open')
  openRoute(@Organiser() organiser: OrganiserIdentity | undefined): { by?: string } {
    return { by: organiser?.name };
  }
}

/** A controller opened up wholesale, with one method closed again. */
@Public()
@Controller('mostly-open')
class MostlyOpenController {
  @Get('read')
  read(): { ok: true } {
    return { ok: true };
  }
}

describe('ApiKeyGuard', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController, MostlyOpenController],
      providers: [
        Reflector,
        { provide: securityConfig.KEY, useValue: security },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
      ],
    }).compile();

    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('a route with no decorator', () => {
    it('is protected by default', async () => {
      // The property the whole design rests on. An endpoint added without
      // thinking about auth is unreachable, not unprotected — the failure is
      // loud and immediate rather than silent and someone else's problem.
      await request(server).get(`/${GLOBAL_PREFIX}/probe/protected`).expect(401);
    });

    it('lets a known key through', async () => {
      await request(server)
        .get(`/${GLOBAL_PREFIX}/probe/protected`)
        .set(API_KEY_HEADER, VALID_KEY)
        .expect(200, { by: 'stockholm-tech' });
    });

    it('tells the two organisers apart', async () => {
      await request(server)
        .get(`/${GLOBAL_PREFIX}/probe/protected`)
        .set(API_KEY_HEADER, OTHER_KEY)
        .expect(200, { by: 'malmo-events' });
    });

    // Note what is *not* here: a trailing space. HTTP trims whitespace around
    // header values, so `sk_test_stockholm ` arrives as the real key and is
    // accepted — correctly, and not something the guard could change.
    it.each([
      ['an unknown key', 'sk_test_not_a_real_key'],
      ['an empty key', ''],
      ['a truncated key', VALID_KEY.slice(0, -1)],
      ['a key in the wrong case', VALID_KEY.toUpperCase()],
      ['the organiser name instead of the key', 'stockholm-tech'],
    ])('refuses %s', async (_label, key) => {
      await request(server)
        .get(`/${GLOBAL_PREFIX}/probe/protected`)
        .set(API_KEY_HEADER, key)
        .expect(401);
    });

    it('gives the same answer for a wrong key as for no key at all', async () => {
      // Distinguishing them confirms to somebody probing the API that a string
      // they found somewhere is a real key, which is the one thing they were
      // trying to establish.
      const missing = await request(server).get(`/${GLOBAL_PREFIX}/probe/protected`).expect(401);
      const wrong = await request(server)
        .get(`/${GLOBAL_PREFIX}/probe/protected`)
        .set(API_KEY_HEADER, 'sk_test_wrong')
        .expect(401);

      expect(wrong.body).toEqual(missing.body);
    });

    it('answers in the problem shape', async () => {
      const response = await request(server).get(`/${GLOBAL_PREFIX}/probe/protected`).expect(401);

      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(response.body).toMatchObject({
        type: 'urn:problem-type:event-booking:unauthorized',
        status: 401,
      });
      expect(JSON.stringify(response.body)).toMatch(new RegExp(API_KEY_HEADER));
    });

    it('never echoes the key that was presented', async () => {
      const response = await request(server)
        .get(`/${GLOBAL_PREFIX}/probe/protected`)
        .set(API_KEY_HEADER, 'sk_test_leaked_secret')
        .expect(401);

      expect(JSON.stringify(response.body)).not.toMatch(/sk_test_leaked_secret/);
    });
  });

  describe('a @Public() route', () => {
    it('needs no key', async () => {
      await request(server).get(`/${GLOBAL_PREFIX}/probe/open`).expect(200);
    });

    it('still resolves nobody, so @Organiser() is undefined', async () => {
      const response = await request(server).get(`/${GLOBAL_PREFIX}/probe/open`).expect(200);

      expect(response.body).toEqual({});
    });

    it('is unbothered by a wrong key rather than rejecting it', async () => {
      await request(server)
        .get(`/${GLOBAL_PREFIX}/probe/open`)
        .set(API_KEY_HEADER, 'sk_test_nonsense')
        .expect(200);
    });
  });

  describe('@Public() on a whole controller', () => {
    it('opens every route inside it', async () => {
      // getAllAndOverride checks the handler first and then the class, so a
      // controller can be opened up wholesale.
      await request(server).get(`/${GLOBAL_PREFIX}/mostly-open/read`).expect(200);
    });
  });
});
