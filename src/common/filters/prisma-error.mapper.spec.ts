import {
  AlreadyExistsError,
  ResourceInUseError,
  ResourceNotFoundError,
  ValidationFailedError,
} from '../errors/domain-error';
import { isPrismaKnownError, mapPrismaError } from './prisma-error.mapper';

/**
 * The fixtures below are the real shapes, copied from what Prisma 7.10 on
 * @prisma/adapter-pg actually produced against this schema. Inventing them
 * would have tested the mapper against a guess.
 */

function uniqueViolation(index: string, table: string, model: string): unknown {
  return {
    name: 'PrismaClientKnownRequestError',
    code: 'P2002',
    meta: {
      modelName: model,
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: `duplicate key value violates unique constraint "${index}"`,
          kind: 'UniqueConstraintViolation',
          constraint: { index },
          table,
        },
      },
    },
  };
}

/**
 * Note the `detail`: PostgreSQL puts the entire failing row into a CHECK
 * violation message, every column value included. That is precisely what must
 * never reach a client.
 */
function checkViolation(constraint: string): unknown {
  return {
    name: 'PrismaClientKnownRequestError',
    code: 'P2039',
    meta: {
      modelName: 'Event',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23514',
          originalMessage: `new row for relation "events" violates check constraint "${constraint}"`,
          kind: 'postgres',
          detail:
            'Failing row contains (01a04169-2deb-7154-a6f7-052087fb82c8, Secret Board Offsite, ' +
            'internal only, Boardroom 3, 2026-09-10 04:10:07.175+00, 0, t, PUBLISHED).',
        },
      },
    },
  };
}

const restrictViolation = {
  name: 'PrismaClientKnownRequestError',
  code: 'P2003',
  meta: {
    modelName: 'Attendee',
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23001',
        originalMessage:
          'update or delete on table "attendees" violates RESTRICT setting of foreign key ' +
          'constraint "registrations_attendee_id_fkey" on table "registrations"',
        kind: 'RestrictViolation',
        constraint: { index: 'registrations_attendee_id_fkey' },
      },
    },
  },
};

const notFound = {
  name: 'PrismaClientKnownRequestError',
  code: 'P2025',
  meta: { modelName: 'Event', operation: 'an update' },
};

describe('isPrismaKnownError', () => {
  it.each([
    ['a P-coded object', { code: 'P2002' }, true],
    ['a plain Error', new Error('boom'), false],
    ['null', null, false],
    ['a string', 'P2002', false],
    ['an HTTP-ish code', { code: '404' }, false],
    ['a malformed code', { code: 'P22' }, false],
  ])('recognises %s', (_label, value, expected) => {
    expect(isPrismaKnownError(value)).toBe(expected);
  });
});

describe('mapPrismaError', () => {
  it('returns undefined for anything that is not a Prisma error', () => {
    expect(mapPrismaError(new Error('boom'))).toBeUndefined();
    expect(mapPrismaError({ code: 'P9999' })).toBeUndefined();
  });

  describe('unique violations (P2002)', () => {
    it('tells a duplicate registration apart from a duplicate email', () => {
      // The reason the mapper reads the nested constraint name at all: the
      // top-level code is P2002 for both, and a client handles them completely
      // differently.
      const registration = mapPrismaError(
        uniqueViolation('ux_registration_active', 'registrations', 'Registration'),
      );
      const email = mapPrismaError(
        uniqueViolation('ux_attendees_email_lower', 'attendees', 'Attendee'),
      );

      expect(registration).toBeInstanceOf(AlreadyExistsError);
      expect(registration?.message).toMatch(/already holds an active registration/);

      expect(email).toBeInstanceOf(AlreadyExistsError);
      expect(email?.message).toMatch(/email address already exists/);

      expect(registration?.message).not.toBe(email?.message);
    });

    it('names what the conflict was on', () => {
      const error = mapPrismaError(
        uniqueViolation('ux_attendees_email_lower', 'attendees', 'Attendee'),
      );

      expect(error?.extensions()).toEqual({ conflictingOn: 'email' });
      expect(error?.status).toBe(409);
    });

    it('still answers 409 for an index it has never heard of', () => {
      const error = mapPrismaError(uniqueViolation('ux_something_new', 'events', 'Event'));

      expect(error).toBeInstanceOf(AlreadyExistsError);
      expect(error?.status).toBe(409);
    });
  });

  describe('foreign key violations (P2003)', () => {
    it('maps a RESTRICT to a 409 that says what is holding the reference', () => {
      const error = mapPrismaError(restrictViolation);

      expect(error).toBeInstanceOf(ResourceInUseError);
      expect(error?.status).toBe(409);
      expect(error?.extensions()).toEqual({ referencedBy: 'registrations' });
      expect(error?.message).toMatch(/still holds registrations/);
    });
  });

  describe('missing records (P2025)', () => {
    it('maps to a 404 naming the model', () => {
      const error = mapPrismaError(notFound);

      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect(error?.status).toBe(404);
      expect(error?.extensions()).toEqual({ resource: 'event' });
    });

    it('does not invent a resource id it was never told', () => {
      const error = mapPrismaError(notFound);

      expect(error?.extensions()).not.toHaveProperty('resourceId');
    });
  });

  describe('check violations (P2039)', () => {
    it('recovers the constraint name from the message, since nothing else carries it', () => {
      const error = mapPrismaError(checkViolation('ck_events_capacity'));

      expect(error).toBeInstanceOf(ValidationFailedError);
      expect(error?.status).toBe(400);
      expect(error?.extensions()).toEqual({
        errors: [{ field: 'capacity', message: 'capacity must be at least 1' }],
      });
    });

    it('phrases the duration rule against the field a client actually sent', () => {
      const error = mapPrismaError(checkViolation('ck_events_ends_after'));

      expect(error?.extensions()).toEqual({
        errors: [{ field: 'endsAt', message: 'endsAt must be after startsAt' }],
      });
    });

    it('stays generic for a constraint it does not recognise', () => {
      const error = mapPrismaError(checkViolation('ck_something_new'));

      expect(error?.extensions()).toEqual({
        errors: [
          { field: 'ck_something_new', message: 'the value violates a database constraint' },
        ],
      });
    });
  });

  describe('never leaking the driver message', () => {
    it.each([
      ['a check violation', checkViolation('ck_events_capacity')],
      ['an unrecognised check violation', checkViolation('ck_unknown')],
      ['a unique violation', uniqueViolation('ux_attendees_email_lower', 'attendees', 'Attendee')],
      ['a restrict violation', restrictViolation],
    ])('keeps the row contents out of the mapped error for %s', (_label, raw) => {
      // The single most important assertion in this file. A CHECK violation's
      // message contains every column of the row that failed — here a private
      // event title and an internal note — and a filter that forwards it turns
      // a validation error into a data leak.
      const error = mapPrismaError(raw);
      const rendered = JSON.stringify({
        message: error?.message,
        extensions: error?.extensions(),
      });

      expect(rendered).not.toMatch(/Secret Board Offsite/);
      expect(rendered).not.toMatch(/internal only/);
      expect(rendered).not.toMatch(/Failing row contains/);
      expect(rendered).not.toMatch(/duplicate key value/);
      expect(rendered).not.toMatch(/RESTRICT setting/);
    });
  });
});
