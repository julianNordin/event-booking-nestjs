import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { GLOBAL_PREFIX } from '../../src/config/app.config';
import { API_KEY_HEADER, createTestApp, ORGANISER_KEY } from '../support/app';

const DAY = 24 * 60 * 60 * 1000;

interface Json {
  [key: string]: unknown;
}

/**
 * The organiser's whole working day, over HTTP, against the real application.
 *
 * Nothing here reaches into a service or a repository. Every assertion is on
 * what a client actually receives — status, headers and body — because that is
 * the only contract this project has with anybody.
 */
describe('the organiser journey', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    ({ app, server } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const asOrganiser = (): Record<string, string> => ({ [API_KEY_HEADER]: ORGANISER_KEY });

  const draftEvent = (overrides: Json = {}): Json => {
    const startsAt = new Date(Date.now() + 30 * DAY);

    return {
      title: 'Distributed Systems in Practice',
      description: 'Consensus, partial failure, and what only shows up under load.',
      venue: 'Norra Latin, Stockholm',
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 8 * 60 * 60 * 1000).toISOString(),
      capacity: 2,
      waitlistEnabled: true,
      ...overrides,
    };
  };

  it('creates, publishes, edits and cancels an event', async () => {
    // --- create ------------------------------------------------------------
    const created = await request(server)
      .post(`/${GLOBAL_PREFIX}/events`)
      .set(asOrganiser())
      .send(draftEvent())
      .expect(201);

    const location = String(created.headers.location);
    expect(location).toBe(`/${GLOBAL_PREFIX}/events/${String((created.body as Json).id)}`);

    expect(created.body).toMatchObject({
      status: 'DRAFT',
      capacity: 2,
      confirmedCount: 0,
      waitlistCount: 0,
      availableSeats: 2,
    });

    // The Location header is followed rather than merely matched: it is a
    // promise that something is served there.
    const followed = await request(server).get(location).expect(200);
    expect((followed.body as Json).id).toBe((created.body as Json).id);

    const eventId = String((created.body as Json).id);

    // --- a draft is not yet visible for registration ------------------------
    const tooEarly = await request(server)
      .post(`/${GLOBAL_PREFIX}/events/${eventId}/registrations`)
      .send({ attendeeId: '0195e3a0-0000-7000-8000-0000deadbeef' })
      .expect(404);
    expect((tooEarly.body as Json).resource).toBe('attendee');

    // --- publish ------------------------------------------------------------
    const published = await request(server)
      .post(`/${GLOBAL_PREFIX}/events/${eventId}/publish`)
      .set(asOrganiser())
      .expect(200);
    expect((published.body as Json).status).toBe('PUBLISHED');

    // --- publishing twice is refused, and says why --------------------------
    const again = await request(server)
      .post(`/${GLOBAL_PREFIX}/events/${eventId}/publish`)
      .set(asOrganiser())
      .expect(409);

    expect(again.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(again.body).toMatchObject({
      type: 'urn:problem-type:event-booking:transition-not-allowed',
      currentStatus: 'PUBLISHED',
      requestedAction: 'publish',
    });
    expect(String((again.body as Json).detail)).toMatch(/already published/);

    // --- edit ---------------------------------------------------------------
    const renamed = await request(server)
      .patch(`/${GLOBAL_PREFIX}/events/${eventId}`)
      .set(asOrganiser())
      .send({ title: 'Distributed Systems in Practice (2nd run)' })
      .expect(200);
    expect((renamed.body as Json).title).toBe('Distributed Systems in Practice (2nd run)');
    expect((renamed.body as Json).venue).toBe('Norra Latin, Stockholm');

    // --- a published event cannot be deleted --------------------------------
    const refusedDelete = await request(server)
      .delete(`/${GLOBAL_PREFIX}/events/${eventId}`)
      .set(asOrganiser())
      .expect(409);
    expect(String((refusedDelete.body as Json).detail)).toMatch(/cancel it/);

    // --- cancel -------------------------------------------------------------
    const cancelled = await request(server)
      .post(`/${GLOBAL_PREFIX}/events/${eventId}/cancel`)
      .set(asOrganiser())
      .expect(200);
    expect((cancelled.body as Json).status).toBe('CANCELLED');

    // --- and a cancelled event is terminal ----------------------------------
    await request(server)
      .post(`/${GLOBAL_PREFIX}/events/${eventId}/publish`)
      .set(asOrganiser())
      .expect(409);
  });

  it('deletes a draft it never published', async () => {
    const created = await request(server)
      .post(`/${GLOBAL_PREFIX}/events`)
      .set(asOrganiser())
      .send(draftEvent({ title: 'Abandoned idea' }))
      .expect(201);

    const eventId = String((created.body as Json).id);

    await request(server)
      .delete(`/${GLOBAL_PREFIX}/events/${eventId}`)
      .set(asOrganiser())
      .expect(204);

    await request(server).get(`/${GLOBAL_PREFIX}/events/${eventId}`).expect(404);
  });

  it('lists, filters and searches what it has created', async () => {
    for (const title of ['Postgres Internals', 'TypeScript at Scale', 'Kubernetes Operators']) {
      const created = await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .set(asOrganiser())
        .send(draftEvent({ title }))
        .expect(201);

      if (title !== 'Kubernetes Operators') {
        await request(server)
          .post(`/${GLOBAL_PREFIX}/events/${String((created.body as Json).id)}/publish`)
          .set(asOrganiser())
          .expect(200);
      }
    }

    const all = await request(server).get(`/${GLOBAL_PREFIX}/events`).expect(200);
    expect((all.body as { totalItems: number }).totalItems).toBe(3);

    const published = await request(server)
      .get(`/${GLOBAL_PREFIX}/events?status=PUBLISHED`)
      .expect(200);
    expect((published.body as { totalItems: number }).totalItems).toBe(2);

    const searched = await request(server).get(`/${GLOBAL_PREFIX}/events?q=postgres`).expect(200);
    expect((searched.body as { totalItems: number }).totalItems).toBe(1);

    const paged = await request(server).get(`/${GLOBAL_PREFIX}/events?size=2`).expect(200);
    expect(paged.body).toMatchObject({ size: 2, totalPages: 2, hasNext: true, hasPrevious: false });

    // ?size=100000 is clamped rather than refused.
    const clamped = await request(server).get(`/${GLOBAL_PREFIX}/events?size=100000`).expect(200);
    expect((clamped.body as { size: number }).size).toBe(100);

    // ?sort=startsAt is accepted; ?sort=id is not, and it names the alternatives.
    await request(server).get(`/${GLOBAL_PREFIX}/events?sort=startsAt`).expect(200);

    const badSort = await request(server).get(`/${GLOBAL_PREFIX}/events?sort=id`).expect(400);
    const errors = (badSort.body as { errors: { field: string; message: string }[] }).errors;
    expect(errors[0]?.field).toBe('sort');
    expect(errors[0]?.message).toMatch(/startsAt/);
  });
});
