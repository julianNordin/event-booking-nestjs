import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { GLOBAL_PREFIX } from '../../src/config/app.config';
import { createTestApp } from '../support/app';

interface HealthBody {
  status: string;
  info?: Record<string, { status: string }>;
  details?: Record<string, { status: string }>;
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
});
