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
 * Filling an event, overflowing it, and watching the queue be served — all over
 * HTTP, against the real application.
 *
 * This is the journey the whole project exists for. Everything it asserts has
 * been proved at the service level already; the point of doing it again here is
 * that the parts have never been assembled before, and an API is the assembly.
 */
describe('the attendee journey', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    ({ app, server } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const asOrganiser = (): Record<string, string> => ({ [API_KEY_HEADER]: ORGANISER_KEY });

  async function publishEvent(overrides: Json = {}): Promise<string> {
    const startsAt = new Date(Date.now() + 30 * DAY);

    const created = await request(server)
      .post(`/${GLOBAL_PREFIX}/events`)
      .set(asOrganiser())
      .send({
        title: 'Distributed Systems in Practice',
        venue: 'Norra Latin, Stockholm',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 8 * 60 * 60 * 1000).toISOString(),
        capacity: 2,
        waitlistEnabled: true,
        ...overrides,
      })
      .expect(201);

    const id = String((created.body as Json).id);
    await request(server)
      .post(`/${GLOBAL_PREFIX}/events/${id}/publish`)
      .set(asOrganiser())
      .expect(200);

    return id;
  }

  let attendeeSequence = 0;

  async function createAttendee(): Promise<string> {
    // Captured synchronously, before the first await. Reading the shared
    // counter after one would let two concurrent callers see the same number
    // and collide on the case-insensitive email index.
    attendeeSequence += 1;
    const n = attendeeSequence;

    const created = await request(server)
      .post(`/${GLOBAL_PREFIX}/attendees`)
      .send({
        email: `Journey.${String(n)}@Example.COM`,
        name: `Attendee ${String(n)}`,
      })
      .expect(201);

    // Normalised at the boundary, and this is where a client sees it.
    expect((created.body as Json).email).toBe(`journey.${String(n)}@example.com`);

    return String((created.body as Json).id);
  }

  // Returns the supertest Test rather than a promise, so callers can chain
  // .expect() onto it the way every other request in this file does.
  function register(eventId: string, attendeeId: string): request.Test {
    return request(server)
      .post(`/${GLOBAL_PREFIX}/events/${eventId}/registrations`)
      .send({ attendeeId });
  }

  it('fills to capacity, waitlists the overflow, then promotes on a cancellation', async () => {
    const eventId = await publishEvent({ capacity: 2 });
    const [ada, bo, cai] = await Promise.all([
      createAttendee(),
      createAttendee(),
      createAttendee(),
    ]);

    // --- fill to capacity ---------------------------------------------------
    const first = await register(eventId, ada).expect(201);
    expect(first.body).toMatchObject({ status: 'CONFIRMED', waitlistPosition: null });

    const location = String(first.headers.location);
    expect(location).toBe(`/${GLOBAL_PREFIX}/registrations/${String((first.body as Json).id)}`);
    await request(server).get(location).expect(200);

    await register(eventId, bo).expect(201);

    const full = await request(server).get(`/${GLOBAL_PREFIX}/events/${eventId}`).expect(200);
    expect(full.body).toMatchObject({ confirmedCount: 2, availableSeats: 0, waitlistCount: 0 });

    // --- one more goes on the waitlist, at position 1 -----------------------
    const overflow = await register(eventId, cai).expect(201);
    expect(overflow.body).toMatchObject({ status: 'WAITLISTED', waitlistPosition: 1 });

    const queue = await request(server)
      .get(`/${GLOBAL_PREFIX}/events/${eventId}/waitlist`)
      .set(asOrganiser())
      .expect(200);
    expect(queue.body).toEqual([
      expect.objectContaining({ place: 1, waitlistPosition: 1, attendeeId: cai }) as unknown,
    ]);

    // --- registering twice is refused, and names the real reason ------------
    const duplicate = await register(eventId, ada).expect(409);
    expect(duplicate.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(duplicate.body).toMatchObject({
      type: 'urn:problem-type:event-booking:already-exists',
      conflictingOn: 'eventId+attendeeId',
    });
    expect(String((duplicate.body as Json).detail)).toMatch(/already holds an active registration/);
    expect(String((duplicate.body as Json).title)).not.toBe('Conflict');

    // --- a confirmed seat is given up, and the queue is served --------------
    await request(server)
      .post(`/${GLOBAL_PREFIX}/registrations/${String((first.body as Json).id)}/cancel`)
      .expect(200);

    const promoted = await request(server)
      .get(`/${GLOBAL_PREFIX}/events/${eventId}/registrations`)
      .set(asOrganiser())
      .expect(200);

    const byAttendee = new Map(
      (promoted.body as { attendeeId: string; status: string }[]).map((registration) => [
        registration.attendeeId,
        registration.status,
      ]),
    );

    expect(byAttendee.get(ada)).toBe('CANCELLED');
    expect(byAttendee.get(bo)).toBe('CONFIRMED');
    expect(byAttendee.get(cai)).toBe('CONFIRMED');

    // The event is full again, and the queue is empty.
    const refilled = await request(server).get(`/${GLOBAL_PREFIX}/events/${eventId}`).expect(200);
    expect(refilled.body).toMatchObject({ confirmedCount: 2, waitlistCount: 0 });

    // --- and the person who cancelled may sign up again ---------------------
    const again = await register(eventId, ada).expect(201);
    expect((again.body as Json).status).toBe('WAITLISTED');
  });

  it('promotes in order when the organiser finds a bigger room', async () => {
    const eventId = await publishEvent({ capacity: 1 });
    const attendees = [await createAttendee(), await createAttendee(), await createAttendee()];

    const positions: (number | null)[] = [];
    for (const attendee of attendees) {
      const response = await register(eventId, attendee).expect(201);
      positions.push((response.body as { waitlistPosition: number | null }).waitlistPosition);
    }

    expect(positions).toEqual([null, 1, 2]);

    await request(server)
      .patch(`/${GLOBAL_PREFIX}/events/${eventId}`)
      .set(asOrganiser())
      .send({ capacity: 3 })
      .expect(200);

    const after = await request(server).get(`/${GLOBAL_PREFIX}/events/${eventId}`).expect(200);
    expect(after.body).toMatchObject({ capacity: 3, confirmedCount: 3, waitlistCount: 0 });
  });

  it('cancels every registration when the event itself is cancelled', async () => {
    const eventId = await publishEvent({ capacity: 1 });
    const [confirmed, waiting] = [await createAttendee(), await createAttendee()];

    await register(eventId, confirmed).expect(201);
    await register(eventId, waiting).expect(201);

    await request(server)
      .post(`/${GLOBAL_PREFIX}/events/${eventId}/cancel`)
      .set(asOrganiser())
      .expect(200);

    const roster = await request(server)
      .get(`/${GLOBAL_PREFIX}/events/${eventId}/registrations`)
      .set(asOrganiser())
      .expect(200);

    const statuses = (roster.body as { status: string }[]).map((r) => r.status);
    expect(statuses).toEqual(['CANCELLED', 'CANCELLED']);

    // And nobody may join a cancelled event.
    const late = await register(eventId, await createAttendee()).expect(409);
    expect((late.body as Json).rule).toBe('event-cancelled');
  });

  it('lets an attendee see their own history across events', async () => {
    const attendee = await createAttendee();
    const [first, second] = [await publishEvent(), await publishEvent()];

    await register(first, attendee).expect(201);
    await register(second, attendee).expect(201);

    const history = await request(server)
      .get(`/${GLOBAL_PREFIX}/attendees/${attendee}/registrations`)
      .expect(200);

    expect(history.body).toHaveLength(2);
    expect(
      (history.body as { eventId: string }[]).map((registration) => registration.eventId).sort(),
    ).toEqual([first, second].sort());
  });
});
