import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { GLOBAL_PREFIX } from '../../src/config/app.config';
import { REQUEST_ID_HEADER } from '../../src/common/interceptors/logging.interceptor';
import { API_KEY_HEADER, createTestApp, ORGANISER_KEY } from '../support/app';

const DAY = 24 * 60 * 60 * 1000;
const ABSENT_ID = '0195e3a0-0000-7000-8000-0000deadbeef';

interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  [key: string]: unknown;
}

/**
 * Every way this API says no, over HTTP, in one place.
 *
 * Asserted on the bodies rather than the statuses. A suite that checks only
 * status codes passes while the API answers 409 with the word "Conflict" and
 * nothing else, which is the exact failure RFC 9457 exists to prevent.
 */
describe('failure paths', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    ({ app, server } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const validEvent = (): Record<string, unknown> => {
    const startsAt = new Date(Date.now() + 30 * DAY);

    return {
      title: 'Distributed Systems in Practice',
      venue: 'Norra Latin, Stockholm',
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 8 * 60 * 60 * 1000).toISOString(),
      capacity: 10,
    };
  };

  describe('401, on a route that needs a key', () => {
    it('refuses a request with no key, as problem+json', async () => {
      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .send(validEvent())
        .expect(401);

      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(response.body as Problem).toMatchObject({
        type: 'urn:problem-type:event-booking:unauthorized',
        status: 401,
      });
      expect(String((response.body as Problem).detail)).toMatch(API_KEY_HEADER);
    });

    it('refuses a wrong key identically to no key at all', async () => {
      const none = await request(server).post(`/${GLOBAL_PREFIX}/events`).send(validEvent());
      const wrong = await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .set(API_KEY_HEADER, 'sk_test_definitely_not_real')
        .send(validEvent());

      expect(none.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect((wrong.body as Problem).detail).toBe((none.body as Problem).detail);
    });

    it('accepts the same request once the key is present', async () => {
      // The 401/200 pair. Without the second half, a guard that rejected
      // everything unconditionally would pass the first.
      await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .set(API_KEY_HEADER, ORGANISER_KEY)
        .send(validEvent())
        .expect(201);
    });

    it('leaves the public routes reachable', async () => {
      await request(server).get(`/${GLOBAL_PREFIX}/events`).expect(200);
    });
  });

  describe('400, on a request that does not make sense', () => {
    it('names every offending field, not just the first', async () => {
      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .set(API_KEY_HEADER, ORGANISER_KEY)
        .send({ ...validEvent(), title: '', capacity: 0 })
        .expect(400);

      const errors = (response.body as { errors: { field: string }[] }).errors;
      expect(errors.map((error) => error.field).sort()).toEqual(['capacity', 'title']);
    });

    it('refuses an unknown property rather than discarding it', async () => {
      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .set(API_KEY_HEADER, ORGANISER_KEY)
        .send({ ...validEvent(), capcity: 40 })
        .expect(400);

      expect(JSON.stringify(response.body)).toMatch(/capcity/);
    });

    it('refuses a status the client tried to set directly', async () => {
      // The one route around the state machine.
      await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .set(API_KEY_HEADER, ORGANISER_KEY)
        .send({ ...validEvent(), status: 'PUBLISHED' })
        .expect(400);
    });

    it('refuses an incoherent schedule with the field named', async () => {
      const startsAt = new Date(Date.now() + 30 * DAY);
      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .set(API_KEY_HEADER, ORGANISER_KEY)
        .send({ ...validEvent(), startsAt: startsAt.toISOString(), endsAt: startsAt.toISOString() })
        .expect(400);

      const errors = (response.body as { errors: { field: string }[] }).errors;
      expect(errors[0]?.field).toBe('endsAt');
    });

    it('refuses a malformed id before anything is looked up', async () => {
      await request(server).get(`/${GLOBAL_PREFIX}/events/not-a-uuid`).expect(400);
    });
  });

  describe('404, on something that is not there', () => {
    it('names the resource and the id', async () => {
      const response = await request(server)
        .get(`/${GLOBAL_PREFIX}/events/${ABSENT_ID}`)
        .expect(404);

      expect(response.body as Problem).toMatchObject({
        type: 'urn:problem-type:event-booking:resource-not-found',
        resource: 'event',
        resourceId: ABSENT_ID,
      });
    });

    it('answers a route that does not exist in the same shape', async () => {
      // Nest's own 404 would otherwise escape as a differently shaped body, and
      // every client parsing problem+json would need a special case for it.
      const response = await request(server)
        .get(`/${GLOBAL_PREFIX}/nothing-here-at-all`)
        .expect(404);

      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect((response.body as Problem).type).toMatch(/^urn:problem-type:event-booking:/);
    });
  });

  describe('409, on a conflict with the current state', () => {
    it('distinguishes a duplicate email from any other conflict', async () => {
      await request(server)
        .post(`/${GLOBAL_PREFIX}/attendees`)
        .send({ email: 'clash@example.com', name: 'First' })
        .expect(201);

      // Different case: the functional index treats it as the same person.
      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/attendees`)
        .send({ email: 'CLASH@Example.com', name: 'Second' })
        .expect(409);

      expect(response.body as Problem).toMatchObject({
        type: 'urn:problem-type:event-booking:already-exists',
        conflictingOn: 'email',
      });
      expect(String((response.body as Problem).detail)).toMatch(/email address already exists/);
    });

    it('never answers with the bare word Conflict', async () => {
      await request(server)
        .post(`/${GLOBAL_PREFIX}/attendees`)
        .send({ email: 'bare@example.com', name: 'First' })
        .expect(201);

      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/attendees`)
        .send({ email: 'bare@example.com', name: 'Second' })
        .expect(409);

      expect((response.body as Problem).title).not.toBe('Conflict');
      expect((response.body as Problem).detail.length).toBeGreaterThan(20);
    });
  });

  describe('every problem body', () => {
    it('carries the request id, so a caller can quote one string', async () => {
      const response = await request(server)
        .get(`/${GLOBAL_PREFIX}/events/${ABSENT_ID}`)
        .set(REQUEST_ID_HEADER, 'support-ticket-4711')
        .expect(404);

      expect(response.headers[REQUEST_ID_HEADER]).toBe('support-ticket-4711');
      expect((response.body as Problem).requestId).toBe('support-ticket-4711');
    });

    it('reports the route it came from', async () => {
      const response = await request(server)
        .get(`/${GLOBAL_PREFIX}/events/${ABSENT_ID}`)
        .expect(404);

      expect((response.body as Problem).instance).toBe(`/${GLOBAL_PREFIX}/events/${ABSENT_ID}`);
    });

    it('uses a URN type, never an https URL that would have to be served', async () => {
      const response = await request(server)
        .get(`/${GLOBAL_PREFIX}/events/${ABSENT_ID}`)
        .expect(404);

      expect((response.body as Problem).type).toMatch(/^urn:/);
      expect((response.body as Problem).type).not.toMatch(/^https?:/);
    });
  });
});
