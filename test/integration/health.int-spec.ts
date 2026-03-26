import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { GLOBAL_PREFIX } from '../../src/config/app.config';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../support/app';

interface HealthBody {
  status: string;
  info?: Record<string, { status: string }>;
  details?: Record<string, { status: string }>;
}

interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  [key: string]: unknown;
}

describe('the health endpoint', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    ({ app, server } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports up against a database that is really there', async () => {
    const response = await request(server).get('/health').expect(200);
    const body = response.body as HealthBody;

    expect(body.status).toBe('ok');
    expect(body.info?.database?.status).toBe('up');
  });

  it('needs no API key', async () => {
    // A load balancer, an orchestrator and an uptime monitor all have to reach
    // this, and none of them can be handed an organiser's key.
    await request(server).get('/health').expect(200);
  });

  it('sits outside the versioned API prefix', async () => {
    // It reports on the process rather than on the API, so versioning the API
    // should not move it.
    await request(server).get(`/${GLOBAL_PREFIX}/health`).expect(404);
  });

  it('checks the database rather than merely answering', async () => {
    // A health endpoint that returns 200 unconditionally passes every test
    // anybody writes for it and tells an orchestrator nothing at all.
    const response = await request(server).get('/health').expect(200);

    expect(Object.keys((response.body as HealthBody).details ?? {})).toContain('database');
  });

  describe('with the database not answering', () => {
    // The outage is faked at the client rather than by stopping the container:
    // one container is shared by the whole run, and taking it down here would
    // take every later suite with it. What is under test is the shape of the
    // 503 rather than the cause of it, and the cause arrives here as exactly
    // this rejection either way — the real outage was measured by hand against
    // `docker compose stop db`, and the numbers are in the roadmap.
    //
    // The message is the one a real severed pool carries, host and port
    // included, so the assertion about not leaking it has something to bite on.
    const outage = (): Error =>
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:5432 password=hunter2'), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2010',
      });

    let queryRaw: jest.SpyInstance;

    beforeEach(() => {
      queryRaw = jest.spyOn(app.get(PrismaService), '$queryRaw').mockRejectedValue(outage());
    });

    afterEach(() => {
      queryRaw.mockRestore();
    });

    it('answers 503', async () => {
      await request(server).get('/health').expect(503);
    });

    it('answers as application/problem+json, like every other failure here', async () => {
      // The global filter converts Terminus's ServiceUnavailableException the
      // same way it converts everything else, so this is what the wire has
      // always carried. What changed is that the document now says so.
      const response = await request(server).get('/health').expect(503);

      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    });

    it('says which dependency is down and what it reported', async () => {
      const response = await request(server).get('/health').expect(503);
      const problem = response.body as Problem;

      expect(problem.type).toBe('urn:problem-type:event-booking:service-unavailable');
      expect(problem.status).toBe(503);
      expect(problem.detail).toBe('database is not answering');
      expect(problem.failing).toEqual(['database']);
      expect(problem.checks).toMatchObject({ database: { status: 'down', reason: 'P2010' } });
    });

    it('keeps the driver connection details out of the response', async () => {
      // Still the most reliably unauthenticated endpoint on the service, and
      // now it carries a body with room to say more than it should.
      const response = await request(server).get('/health').expect(503);
      const rendered = JSON.stringify(response.body);

      expect(rendered).not.toMatch(/ECONNREFUSED/);
      expect(rendered).not.toMatch(/hunter2/);
      expect(rendered).not.toMatch(/10\.0\.0\.7/);
    });

    it('is still reachable without an API key', async () => {
      // The moment an orchestrator most needs to read this is the moment the
      // service is least able to authenticate anybody.
      await request(server).get('/health').expect(503);
    });

    it('still tells a caching proxy not to keep the answer', async () => {
      // A cached health check is worse than none: it reports the state the
      // service was in when somebody else asked.
      const response = await request(server).get('/health').expect(503);

      expect(response.headers['cache-control']).toMatch(/no-store/);
    });

    it('recovers on its own once the database answers again', async () => {
      await request(server).get('/health').expect(503);

      queryRaw.mockRestore();

      await request(server).get('/health').expect(200);
    });
  });
});
