import type { Server } from 'node:http';

import { Controller, Get, INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { GLOBAL_PREFIX } from '../../config/app.config';
import { configureApp } from '../../configure-app';
import { ResourceNotFoundError } from '../errors/domain-error';
import { REQUEST_ID_HEADER } from './logging.interceptor';

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }

  @Get('slow')
  async slow(): Promise<{ ok: true }> {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new ResourceNotFoundError('event', 'nope');
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

describe('LoggingInterceptor', () => {
  let app: INestApplication;
  let server: Server;
  let logged: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logged.mockRestore();
  });

  const lines = (): string[] => (logged.mock.calls as [unknown][]).map((call) => String(call[0]));

  describe('the request id', () => {
    it('is generated when the client did not supply one', async () => {
      const response = await request(server).get(`/${GLOBAL_PREFIX}/probe/ok`).expect(200);

      expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID);
    });

    it('honours one the client did supply, rather than replacing it', async () => {
      // A trace begun by a proxy or a client has to survive this hop, or the
      // two halves of the same request cannot be joined up afterwards.
      const response = await request(server)
        .get(`/${GLOBAL_PREFIX}/probe/ok`)
        .set(REQUEST_ID_HEADER, 'trace-from-the-gateway')
        .expect(200);

      expect(response.headers[REQUEST_ID_HEADER]).toBe('trace-from-the-gateway');
    });

    it('is different for two separate requests', async () => {
      const [first, second] = await Promise.all([
        request(server).get(`/${GLOBAL_PREFIX}/probe/ok`),
        request(server).get(`/${GLOBAL_PREFIX}/probe/ok`),
      ]);

      expect(first.headers[REQUEST_ID_HEADER]).not.toBe(second.headers[REQUEST_ID_HEADER]);
    });

    it('is the same in the log line as on the response', async () => {
      const response = await request(server)
        .get(`/${GLOBAL_PREFIX}/probe/ok`)
        .set(REQUEST_ID_HEADER, 'joined-up')
        .expect(200);

      expect(response.headers[REQUEST_ID_HEADER]).toBe('joined-up');
      expect(lines().join('\n')).toContain('joined-up');
    });
  });

  describe('the log line', () => {
    it('names the method, the path and the status', async () => {
      await request(server).get(`/${GLOBAL_PREFIX}/probe/ok`).expect(200);

      expect(lines()[0]).toMatch(/GET .*\/probe\/ok 200 /);
    });

    it('reports a duration in milliseconds', async () => {
      await request(server).get(`/${GLOBAL_PREFIX}/probe/ok`).expect(200);

      expect(lines()[0]).toMatch(/\d+\.\dms/);
    });

    it('measures something close to the real elapsed time', async () => {
      await request(server).get(`/${GLOBAL_PREFIX}/probe/slow`).expect(200);

      const match = /(\d+\.\d)ms/.exec(lines()[0] ?? '');
      expect(Number(match?.[1] ?? 0)).toBeGreaterThanOrEqual(20);
    });
  });

  describe('a failing request', () => {
    it('is still logged, with the failure named', async () => {
      // Logged on the way out as well as on success, or every failed request is
      // missing from the timing record — which is the half most wanted when
      // something is slow.
      await request(server).get(`/${GLOBAL_PREFIX}/probe/boom`).expect(404);

      expect(lines().join('\n')).toMatch(/failed \(ResourceNotFoundError\)/);
    });

    it('still gets a request id on the response', async () => {
      const response = await request(server).get(`/${GLOBAL_PREFIX}/probe/boom`).expect(404);

      expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID);
    });

    it('carries the same id in the problem body', async () => {
      // What lets somebody quote one string in a support ticket and have it
      // found in the logs.
      const response = await request(server)
        .get(`/${GLOBAL_PREFIX}/probe/boom`)
        .set(REQUEST_ID_HEADER, 'ticket-1234')
        .expect(404);

      expect((response.body as { requestId?: string }).requestId).toBe('ticket-1234');
    });
  });
});
