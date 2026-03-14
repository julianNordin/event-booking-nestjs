import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ResourceNotFoundError, TransitionNotAllowedError } from '../common/errors/domain-error';
import { GLOBAL_PREFIX } from '../config/app.config';
import { EVENT_LIMITS } from './event-limits';
import { configureApp } from '../configure-app';
import { EventResponseDto } from './dto/event-response.dto';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

const V7_ID = '0195e3a0-0000-7000-8000-000000000001';
const V4_ID = '9f1b4c2e-1f2a-4c3d-8e4f-5a6b7c8d9e0f';

const dto: EventResponseDto = {
  id: V7_ID,
  title: 'Distributed Systems in Practice',
  description: null,
  venue: 'Norra Latin, Stockholm',
  startsAt: '2027-03-29T09:00:00.000Z',
  endsAt: '2027-03-29T17:00:00.000Z',
  capacity: 40,
  waitlistEnabled: true,
  registrationOpensAt: null,
  registrationClosesAt: null,
  status: 'PUBLISHED',
  createdAt: '2027-01-15T10:00:00.000Z',
  updatedAt: '2027-01-15T10:00:00.000Z',
};

/**
 * Runs the controller over real HTTP with the service mocked, so the pieces
 * under test are the ones only HTTP exercises: the global prefix, the parameter
 * pipe, and the status code an exception turns into. None of that needs a
 * database, so it belongs in the fast tier.
 */
describe('EventsController', () => {
  const findAll = jest.fn();
  const findOne = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const publish = jest.fn();
  const cancel = jest.fn();
  const remove = jest.fn();
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        {
          provide: EventsService,
          useValue: { findAll, findOne, create, update, publish, cancel, remove },
        },
      ],
    }).compile();

    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    findAll.mockReset();
    findOne.mockReset();
    create.mockReset();
    update.mockReset();
    publish.mockReset();
    cancel.mockReset();
    remove.mockReset();
  });

  describe('GET /events', () => {
    it('returns the events the service produced', async () => {
      findAll.mockResolvedValue([dto]);

      const response = await request(server).get(`/${GLOBAL_PREFIX}/events`).expect(200);

      expect(response.body).toEqual([dto]);
    });

    it('returns an empty array when there are none', async () => {
      findAll.mockResolvedValue([]);

      await request(server).get(`/${GLOBAL_PREFIX}/events`).expect(200, []);
    });
  });

  describe('GET /events/:id', () => {
    it('returns the event', async () => {
      findOne.mockResolvedValue(dto);

      await request(server).get(`/${GLOBAL_PREFIX}/events/${V7_ID}`).expect(200, dto);
      expect(findOne).toHaveBeenCalledWith(V7_ID);
    });

    it('answers 404 when the service cannot find it', async () => {
      findOne.mockRejectedValue(new ResourceNotFoundError('event', V7_ID));

      await request(server).get(`/${GLOBAL_PREFIX}/events/${V7_ID}`).expect(404);
    });

    it('rejects an id that is not a uuid at all, without reaching the service', async () => {
      await request(server).get(`/${GLOBAL_PREFIX}/events/not-a-uuid`).expect(400);

      expect(findOne).not.toHaveBeenCalled();
    });

    it('rejects a uuid of the wrong version', async () => {
      // This schema issues v7 ids. A v4 id is a well-formed uuid that this
      // service can never have produced, so it is a bad request rather than a
      // lookup that is certain to miss.
      await request(server).get(`/${GLOBAL_PREFIX}/events/${V4_ID}`).expect(400);

      expect(findOne).not.toHaveBeenCalled();
    });
  });

  describe('POST /events', () => {
    const body = {
      title: 'Distributed Systems in Practice',
      venue: 'Norra Latin, Stockholm',
      startsAt: '2027-03-29T09:00:00.000Z',
      endsAt: '2027-03-29T17:00:00.000Z',
      capacity: 40,
    };

    it('answers 201 with the created event', async () => {
      create.mockResolvedValue(dto);

      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .send(body)
        .expect(201);

      expect(response.body).toEqual(dto);
    });

    it('returns a Location header that resolves to the new event', async () => {
      // 201 without Location says something was created and refuses to say
      // where. The header is asserted as a path a client can actually follow.
      create.mockResolvedValue(dto);

      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .send(body)
        .expect(201);

      const location = String(response.headers.location);
      expect(location).toBe(`/${GLOBAL_PREFIX}/events/${V7_ID}`);

      findOne.mockResolvedValue(dto);
      await request(server).get(location).expect(200);
    });

    it('converts the ISO strings to Dates before the service sees them', async () => {
      create.mockResolvedValue(dto);

      await request(server).post(`/${GLOBAL_PREFIX}/events`).send(body).expect(201);

      const [received] = create.mock.calls[0] as [Record<string, unknown>];
      expect(received.startsAt).toBeInstanceOf(Date);
      expect((received.startsAt as Date).toISOString()).toBe('2027-03-29T09:00:00.000Z');
    });

    it.each([
      ['a missing title', { ...body, title: undefined }],
      ['an empty title', { ...body, title: '' }],
      ['a missing venue', { ...body, venue: undefined }],
      ['a capacity of zero', { ...body, capacity: 0 }],
      ['a negative capacity', { ...body, capacity: -1 }],
      ['a fractional capacity', { ...body, capacity: 2.5 }],
      ['a capacity beyond the sane bound', { ...body, capacity: 10_000_000 }],
      ['a start time that is not a date', { ...body, startsAt: 'next tuesday' }],
      ['a missing end time', { ...body, endsAt: undefined }],
    ])('rejects %s', async (_label, payload) => {
      await request(server).post(`/${GLOBAL_PREFIX}/events`).send(payload).expect(400);

      expect(create).not.toHaveBeenCalled();
    });

    it('rejects a status supplied by the client', async () => {
      // The route around the state machine. forbidNonWhitelisted turns it into
      // a 400 rather than a value that is quietly discarded.
      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .send({ ...body, status: 'PUBLISHED' })
        .expect(400);

      expect(JSON.stringify(response.body)).toMatch(/status/);
      expect(create).not.toHaveBeenCalled();
    });

    it('accepts a title of exactly the declared column width', async () => {
      create.mockResolvedValue(dto);

      await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .send({ ...body, title: 'x'.repeat(EVENT_LIMITS.title) })
        .expect(201);
    });

    it('rejects a title one character wider than the column', async () => {
      // Without this the database refuses it instead, as a driver error that
      // names a constraint rather than a field.
      await request(server)
        .post(`/${GLOBAL_PREFIX}/events`)
        .send({ ...body, title: 'x'.repeat(EVENT_LIMITS.title + 1) })
        .expect(400);

      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /events/:id', () => {
    it('passes the id and the partial body to the service', async () => {
      update.mockResolvedValue(dto);

      await request(server)
        .patch(`/${GLOBAL_PREFIX}/events/${V7_ID}`)
        .send({ title: 'Renamed' })
        .expect(200);

      expect(update).toHaveBeenCalledWith(V7_ID, { title: 'Renamed' });
    });

    it('accepts an empty body as a no-op rather than rejecting it', async () => {
      update.mockResolvedValue(dto);

      await request(server).patch(`/${GLOBAL_PREFIX}/events/${V7_ID}`).send({}).expect(200);
    });

    it('rejects a status change, which must go through publish or cancel', async () => {
      await request(server)
        .patch(`/${GLOBAL_PREFIX}/events/${V7_ID}`)
        .send({ status: 'PUBLISHED' })
        .expect(400);

      expect(update).not.toHaveBeenCalled();
    });

    it('still validates the fields that are present', async () => {
      await request(server)
        .patch(`/${GLOBAL_PREFIX}/events/${V7_ID}`)
        .send({ capacity: 0 })
        .expect(400);

      expect(update).not.toHaveBeenCalled();
    });

    it('rejects a malformed id before the service is reached', async () => {
      await request(server)
        .patch(`/${GLOBAL_PREFIX}/events/not-a-uuid`)
        .send({ title: 'x' })
        .expect(400);

      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('the lifecycle routes', () => {
    it('POST /events/:id/publish returns 200 and the updated event', async () => {
      publish.mockResolvedValue({ ...dto, status: 'PUBLISHED' });

      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/events/${V7_ID}/publish`)
        .expect(200);

      expect(response.body).toMatchObject({ status: 'PUBLISHED' });
      expect(publish).toHaveBeenCalledWith(V7_ID);
    });

    it('POST /events/:id/cancel returns 200 and the updated event', async () => {
      cancel.mockResolvedValue({ ...dto, status: 'CANCELLED' });

      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/events/${V7_ID}/cancel`)
        .expect(200);

      expect(response.body).toMatchObject({ status: 'CANCELLED' });
      expect(cancel).toHaveBeenCalledWith(V7_ID);
    });

    it('surfaces a refused transition as 409', async () => {
      publish.mockRejectedValue(
        new TransitionNotAllowedError('this event is already published', 'PUBLISHED', 'publish'),
      );

      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/events/${V7_ID}/publish`)
        .expect(409);

      // The reason travels to the client. "Conflict" on its own tells a caller
      // that something is wrong and nothing about what.
      expect(JSON.stringify(response.body)).toMatch(/already published/);
    });

    it('DELETE /events/:id returns 204 with no body', async () => {
      remove.mockResolvedValue(undefined);

      const response = await request(server)
        .delete(`/${GLOBAL_PREFIX}/events/${V7_ID}`)
        .expect(204);

      expect(response.body).toEqual({});
      expect(remove).toHaveBeenCalledWith(V7_ID);
    });

    it('surfaces a refused delete as 409 with its reason', async () => {
      remove.mockRejectedValue(
        new TransitionNotAllowedError(
          'a published event cannot be deleted; cancel it instead',
          'PUBLISHED',
          'delete',
        ),
      );

      const response = await request(server)
        .delete(`/${GLOBAL_PREFIX}/events/${V7_ID}`)
        .expect(409);

      expect(JSON.stringify(response.body)).toMatch(/cancel it instead/);
    });

    it.each(['publish', 'cancel'])('validates the id before %sing', async (action) => {
      await request(server).post(`/${GLOBAL_PREFIX}/events/not-a-uuid/${action}`).expect(400);

      expect(publish).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    });
  });
});
