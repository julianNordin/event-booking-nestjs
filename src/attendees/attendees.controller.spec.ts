import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';

import { ResourceNotFoundError } from '../common/errors/domain-error';
import { GLOBAL_PREFIX } from '../config/app.config';
import { configureApp } from '../configure-app';
import { ATTENDEE_LIMITS } from './attendee-limits';
import { AttendeesController } from './attendees.controller';
import { AttendeesService } from './attendees.service';
import { AttendeeResponseDto } from './dto/attendee-response.dto';

const ID = '0195e3a0-0000-7000-8000-0000000000a1';

const dto: AttendeeResponseDto = {
  id: ID,
  email: 'ada@example.com',
  name: 'Ada Lindqvist',
  createdAt: '2027-01-15T10:00:00.000Z',
  updatedAt: '2027-01-15T10:00:00.000Z',
};

describe('AttendeesController', () => {
  const create = jest.fn();
  const findOne = jest.fn();
  const findRegistrations = jest.fn();
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // The create route is throttled, so its guard needs the module's providers.
      // A deliberately high limit here: these tests are about the controller,
      // and the throttling itself is covered in its own spec.
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10_000 }])],
      controllers: [AttendeesController],
      providers: [{ provide: AttendeesService, useValue: { create, findOne, findRegistrations } }],
    }).compile();

    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    create.mockReset();
    findOne.mockReset();
    findRegistrations.mockReset();
  });

  describe('POST /attendees', () => {
    it('answers 201 with a Location header', async () => {
      create.mockResolvedValue(dto);

      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/attendees`)
        .send({ email: 'ada@example.com', name: 'Ada Lindqvist' })
        .expect(201);

      expect(response.body).toEqual(dto);
      expect(response.headers.location).toBe(`/${GLOBAL_PREFIX}/attendees/${ID}`);
    });

    it('normalises the address before the service sees it', async () => {
      // Case and surrounding whitespace are folded once, at the boundary, so
      // everything downstream works in one canonical form.
      create.mockResolvedValue(dto);

      await request(server)
        .post(`/${GLOBAL_PREFIX}/attendees`)
        .send({ email: '  Ada@Example.COM  ', name: '  Ada Lindqvist  ' })
        .expect(201);

      expect(create).toHaveBeenCalledWith({
        email: 'ada@example.com',
        name: 'Ada Lindqvist',
      });
    });

    it('surfaces a duplicate address as 409 in the problem shape', async () => {
      // The service does not check first; this is the mapped unique-index
      // violation arriving through the filter.
      create.mockRejectedValue(
        Object.assign(new Error('duplicate'), {
          code: 'P2002',
          meta: {
            modelName: 'Attendee',
            driverAdapterError: {
              cause: { originalCode: '23505', constraint: { index: 'ux_attendees_email_lower' } },
            },
          },
        }),
      );

      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/attendees`)
        .send({ email: 'ada@example.com', name: 'Ada' })
        .expect(409);

      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(response.body).toMatchObject({
        type: 'urn:problem-type:event-booking:already-exists',
        conflictingOn: 'email',
      });
      expect(JSON.stringify(response.body)).toMatch(/email address already exists/);
    });

    it.each([
      ['a missing email', { name: 'Ada' }],
      ['an email with no @', { email: 'ada', name: 'Ada' }],
      ['an empty email', { email: '', name: 'Ada' }],
      ['a missing name', { email: 'ada@example.com' }],
      ['a blank name', { email: 'ada@example.com', name: '   ' }],
      ['an unknown field', { email: 'ada@example.com', name: 'Ada', nickname: 'Ada' }],
    ])('rejects %s', async (_label, body) => {
      await request(server).post(`/${GLOBAL_PREFIX}/attendees`).send(body).expect(400);

      expect(create).not.toHaveBeenCalled();
    });

    it('rejects an address wider than the column', async () => {
      const local = 'a'.repeat(ATTENDEE_LIMITS.email);

      await request(server)
        .post(`/${GLOBAL_PREFIX}/attendees`)
        .send({ email: `${local}@example.com`, name: 'Ada' })
        .expect(400);

      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('GET /attendees/:id', () => {
    it('returns the attendee', async () => {
      findOne.mockResolvedValue(dto);

      await request(server).get(`/${GLOBAL_PREFIX}/attendees/${ID}`).expect(200, dto);
    });

    it('answers 404 in the problem shape when there is none', async () => {
      findOne.mockRejectedValue(new ResourceNotFoundError('attendee', ID));

      const response = await request(server).get(`/${GLOBAL_PREFIX}/attendees/${ID}`).expect(404);

      expect(response.body).toMatchObject({ resource: 'attendee', resourceId: ID });
    });

    it('rejects a malformed id before the service is reached', async () => {
      await request(server).get(`/${GLOBAL_PREFIX}/attendees/not-a-uuid`).expect(400);

      expect(findOne).not.toHaveBeenCalled();
    });
  });

  describe('GET /attendees/:id/registrations', () => {
    it('returns the registrations', async () => {
      findRegistrations.mockResolvedValue([
        {
          id: 'r1',
          eventId: 'e1',
          attendeeId: ID,
          status: 'CONFIRMED',
          waitlistPosition: null,
          registeredAt: '2027-02-01T09:00:00.000Z',
          cancelledAt: null,
        },
      ]);

      const response = await request(server)
        .get(`/${GLOBAL_PREFIX}/attendees/${ID}/registrations`)
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(findRegistrations).toHaveBeenCalledWith(ID);
    });

    it('answers 404 for an attendee that does not exist', async () => {
      findRegistrations.mockRejectedValue(new ResourceNotFoundError('attendee', ID));

      await request(server).get(`/${GLOBAL_PREFIX}/attendees/${ID}/registrations`).expect(404);
    });
  });
});
