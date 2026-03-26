import type { Server } from 'node:http';

import {
  Body,
  Controller,
  Get,
  INestApplication,
  Logger,
  NotFoundException,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import { IsInt, IsString, Min } from 'class-validator';
import request from 'supertest';

import { GLOBAL_PREFIX } from '../../config/app.config';
import { configureApp } from '../../configure-app';
import {
  AlreadyExistsError,
  DependencyUnavailableError,
  ResourceInUseError,
  ResourceNotFoundError,
  RuleViolationError,
  TransitionNotAllowedError,
} from '../errors/domain-error';

class ProbeDto {
  @IsString()
  title!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  capacity!: number;
}

/**
 * The real shape of a CHECK violation, including the row PostgreSQL leaks into
 * it. Built on an Error because that is what Prisma actually throws — a plain
 * object would test the filter against something it will never see.
 */
const checkViolation = Object.assign(new Error('Invalid `prisma.event.create()` invocation'), {
  name: 'PrismaClientKnownRequestError',
  code: 'P2039',
  meta: {
    modelName: 'Event',
    driverAdapterError: {
      cause: {
        originalCode: '23514',
        originalMessage:
          'new row for relation "events" violates check constraint "ck_events_capacity"',
        detail: 'Failing row contains (uuid, Secret Board Offsite, internal only, 0).',
      },
    },
  },
});

@Controller('probe')
class ProbeController {
  @Get('not-found')
  notFound(): never {
    throw new ResourceNotFoundError('event', '0195e3a0-0000-7000-8000-000000000001');
  }

  @Get('transition')
  transition(): never {
    throw new TransitionNotAllowedError('this event is already published', 'PUBLISHED', 'publish');
  }

  @Get('exists')
  exists(): never {
    throw new AlreadyExistsError('an attendee with that email address already exists', 'email');
  }

  @Get('in-use')
  inUse(): never {
    throw new ResourceInUseError('this attendee still holds registrations', 'registrations');
  }

  @Get('rule')
  rule(): never {
    throw new RuleViolationError(
      'capacity cannot be reduced below 12',
      'capacity-covers-confirmed',
      {
        confirmed: 12,
      },
    );
  }

  @Get('prisma-check')
  prismaCheck(): never {
    throw checkViolation;
  }

  @Get('dependency-down')
  dependencyDown(): never {
    throw new DependencyUnavailableError(['database'], {
      database: { status: 'down', reason: 'P2010' },
    });
  }

  @Get('http-exception')
  httpException(): never {
    throw new NotFoundException('nothing here');
  }

  @Get('raw-unavailable')
  rawUnavailable(): never {
    throw new ServiceUnavailableException('the thing is not answering');
  }

  @Get('boom')
  boom(): never {
    throw new Error('connect ECONNREFUSED 10.0.0.7:5432 — password=hunter2');
  }

  @Post('validate')
  validate(@Body() body: ProbeDto): ProbeDto {
    return body;
  }
}

interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  [key: string]: unknown;
}

describe('ProblemDetailsFilter', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  const get = async (path: string, status: number): Promise<Problem> => {
    const response = await request(server).get(`/${GLOBAL_PREFIX}/probe/${path}`).expect(status);
    return response.body as Problem;
  };

  describe('the envelope', () => {
    it('is served as application/problem+json, not application/json', async () => {
      // The media type is how a client knows it can parse this shape at all.
      const response = await request(server).get(`/${GLOBAL_PREFIX}/probe/not-found`).expect(404);

      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    });

    it.each([
      ['not-found', 404],
      ['transition', 409],
      ['exists', 409],
      ['in-use', 409],
      ['rule', 409],
      ['dependency-down', 503],
      ['http-exception', 404],
      ['boom', 500],
    ])('carries all five standard members for %s', async (path, status) => {
      const problem = await get(path, status);

      expect(typeof problem.type).toBe('string');
      expect(typeof problem.title).toBe('string');
      expect(problem.status).toBe(status);
      expect(typeof problem.detail).toBe('string');
      expect(problem.instance).toBe(`/${GLOBAL_PREFIX}/probe/${path}`);
    });

    it.each([
      ['not-found', 404],
      ['transition', 409],
      ['exists', 409],
      ['rule', 409],
      ['dependency-down', 503],
      ['http-exception', 404],
      ['boom', 500],
    ])('uses a URN problem type for %s, never an https URL', async (path, status) => {
      const problem = await get(path, status);

      expect(problem.type).toMatch(/^urn:problem-type:event-booking:/);
      expect(problem.type).not.toMatch(/^https?:/);
    });
  });

  describe('domain errors', () => {
    it('puts extensions at the top level, as RFC 9457 requires', async () => {
      const problem = await get('not-found', 404);

      expect(problem.resource).toBe('event');
      expect(problem.resourceId).toBe('0195e3a0-0000-7000-8000-000000000001');
      expect(problem).not.toHaveProperty('extensions');
    });

    it('says which state change was refused, not just "Conflict"', async () => {
      const problem = await get('transition', 409);

      expect(problem.detail).toBe('this event is already published');
      expect(problem.currentStatus).toBe('PUBLISHED');
      expect(problem.requestedAction).toBe('publish');
      expect(problem.title).not.toBe('Conflict');
    });

    it('distinguishes two different 409s by their type', async () => {
      const [exists, inUse] = await Promise.all([get('exists', 409), get('in-use', 409)]);

      expect(exists.type).not.toBe(inUse.type);
      expect(exists.conflictingOn).toBe('email');
      expect(inUse.referencedBy).toBe('registrations');
    });

    it('merges rule details into the problem', async () => {
      const problem = await get('rule', 409);

      expect(problem.rule).toBe('capacity-covers-confirmed');
      expect(problem.confirmed).toBe(12);
    });
  });

  describe('a dependency being down', () => {
    it('answers 503 in the same shape as every other failure', async () => {
      // /health is the one route in this API whose failure is routine rather
      // than exceptional, and it was the one route whose body did not say what
      // had gone wrong.
      const problem = await get('dependency-down', 503);

      expect(problem.type).toBe('urn:problem-type:event-booking:service-unavailable');
      expect(problem.detail).toBe('database is not answering');
    });

    it('names which checks failed, and what each of them reported', async () => {
      // Without this the body reads "Service Unavailable Exception" and an
      // operator has to go to the logs to learn which dependency is down —
      // which is the single fact the response exists to carry.
      const problem = await get('dependency-down', 503);

      expect(problem.failing).toEqual(['database']);
      expect(problem.checks).toEqual({ database: { status: 'down', reason: 'P2010' } });
    });

    it('gives a bare ServiceUnavailableException a named type too', async () => {
      // 503 was missing from the status table, so anything throwing Nest's own
      // ServiceUnavailableException fell through to the unnamed catch-all.
      const problem = await get('raw-unavailable', 503);

      expect(problem.type).toBe('urn:problem-type:event-booking:service-unavailable');
      expect(problem.title).not.toBe('The request failed');
    });
  });

  describe('what reaches the log', () => {
    it('records the original of a failure the client is not told about', async () => {
      // The 500 body says "an unexpected condition" and nothing else, so the
      // log is the only place the real error survives. Losing it there would
      // leave nobody able to debug it.
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await get('boom', 500);

      expect(error).toHaveBeenCalled();
      expect(String(error.mock.calls[0]?.[1])).toMatch(/ECONNREFUSED/);

      error.mockRestore();
    });

    it('stays quiet about a 5xx the response already explains in full', async () => {
      // A dependency being down is reported on a timer for as long as the
      // outage lasts, and the response carries the whole reason. Logging it as
      // an "unhandled failure" with a stack, once per poll, is both untrue and
      // the fastest way to bury the entry that does matter.
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await get('dependency-down', 503);

      expect(error).not.toHaveBeenCalled();

      error.mockRestore();
    });
  });

  describe('prisma errors that escape the service', () => {
    it('are translated rather than becoming a 500', async () => {
      const problem = await get('prisma-check', 400);

      expect(problem.status).toBe(400);
      expect(problem.errors).toEqual([
        { field: 'capacity', message: 'capacity must be at least 1' },
      ]);
    });

    it('never carry the failing row into the response', async () => {
      const problem = await get('prisma-check', 400);

      expect(JSON.stringify(problem)).not.toMatch(/Secret Board Offsite/);
      expect(JSON.stringify(problem)).not.toMatch(/Failing row contains/);
    });
  });

  describe('unexpected failures', () => {
    it('answer 500 without echoing the original message', async () => {
      // The thrown error carries a host, a port and a password. None of it is
      // the client's business, and all of it is useful to an attacker.
      const problem = await get('boom', 500);

      expect(problem.detail).toBe('The server encountered an unexpected condition.');
      expect(JSON.stringify(problem)).not.toMatch(/ECONNREFUSED/);
      expect(JSON.stringify(problem)).not.toMatch(/hunter2/);
      expect(JSON.stringify(problem)).not.toMatch(/10\.0\.0\.7/);
    });
  });

  describe('validation failures', () => {
    it('answer 400 with a per-field list', async () => {
      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/probe/validate`)
        .send({ capacity: 0 })
        .expect(400);

      const problem = response.body as Problem;
      const errors = problem.errors as { field: string; message: string }[];

      expect(problem.type).toBe('urn:problem-type:event-booking:validation-failed');
      expect(errors.map((error) => error.field).sort()).toEqual(['capacity', 'title']);
    });

    it('name an unexpected property rather than discarding it', async () => {
      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/probe/validate`)
        .send({ title: 'x', capacity: 5, capcity: 9 })
        .expect(400);

      const errors = (response.body as Problem).errors as { field: string }[];

      expect(errors.map((error) => error.field)).toContain('capcity');
    });

    it('are served as problem+json too', async () => {
      const response = await request(server)
        .post(`/${GLOBAL_PREFIX}/probe/validate`)
        .send({})
        .expect(400);

      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    });
  });

  describe('routes that do not exist', () => {
    it('still answer in the problem shape', async () => {
      // Nest's own 404 would otherwise escape as a differently-shaped body, and
      // every client parsing problem+json would need a special case for it.
      const response = await request(server).get(`/${GLOBAL_PREFIX}/nothing-here`).expect(404);

      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect((response.body as Problem).type).toMatch(/^urn:problem-type:event-booking:/);
    });
  });
});
