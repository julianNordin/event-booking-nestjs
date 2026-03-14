import {
  AlreadyExistsError,
  DomainError,
  ResourceInUseError,
  ResourceNotFoundError,
  ValidationFailedError,
} from '../errors/domain-error';

/**
 * Turns a Prisma driver failure into a domain error.
 *
 * Prisma 7 with a driver adapter nests the real database error two levels down,
 * at `meta.driverAdapterError.cause`, and **only there is the constraint
 * named**. The top-level code is P2002 for every unique index in the schema
 * alike, which cannot tell "this person already registered" from "that email is
 * taken" — two conflicts a client needs to handle completely differently.
 *
 * Measured codes:
 *
 *   P2002  23505  unique violation      cause.constraint.index
 *   P2003  23001  foreign key violation cause.constraint.index
 *   P2025   —     record not found      meta.modelName
 *   P2039  23514  check violation       nowhere structured; parsed from the message
 *
 * Nothing here ever puts `cause.originalMessage` into a response. For a CHECK
 * violation PostgreSQL includes the **entire failing row** in that message,
 * every column value included, and the filter's whole job is to make sure that
 * never reaches a client. The message is read only to recover the constraint
 * name, and what goes out is written here.
 */

interface DriverCause {
  originalCode?: string;
  originalMessage?: string;
  constraint?: { index?: string };
}

interface PrismaLikeError {
  code?: unknown;
  meta?: {
    modelName?: string;
    driverAdapterError?: { cause?: DriverCause };
  };
}

/** What each unique index means, in the domain's own words. */
const UNIQUE_CONSTRAINTS: Record<string, () => DomainError> = {
  ux_registration_active: () =>
    new AlreadyExistsError(
      'this attendee already holds an active registration for this event',
      'eventId+attendeeId',
    ),
  ux_attendees_email_lower: () =>
    new AlreadyExistsError('an attendee with that email address already exists', 'email'),
};

/** What each CHECK constraint means, phrased against the field a client sent. */
const CHECK_CONSTRAINTS: Record<string, { field: string; message: string }> = {
  ck_events_capacity: { field: 'capacity', message: 'capacity must be at least 1' },
  ck_events_ends_after: { field: 'endsAt', message: 'endsAt must be after startsAt' },
};

const FOREIGN_KEYS: Record<string, () => DomainError> = {
  registrations_attendee_id_fkey: () =>
    new ResourceInUseError(
      'this attendee still holds registrations and cannot be deleted',
      'registrations',
    ),
  registrations_event_id_fkey: () => new ResourceInUseError('that event does not exist', 'events'),
};

export function isPrismaKnownError(error: unknown): error is PrismaLikeError {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const code = (error as PrismaLikeError).code;
  return typeof code === 'string' && /^P\d{4}$/.test(code);
}

export function mapPrismaError(error: unknown): DomainError | undefined {
  if (!isPrismaKnownError(error)) {
    return undefined;
  }

  const cause = error.meta?.driverAdapterError?.cause;
  const constraint = cause?.constraint?.index ?? checkConstraintName(cause?.originalMessage);

  switch (error.code) {
    case 'P2002':
      return (
        (constraint === undefined ? undefined : UNIQUE_CONSTRAINTS[constraint]?.()) ??
        new AlreadyExistsError('a record with those values already exists', constraint ?? 'unknown')
      );

    case 'P2003':
      return (
        (constraint === undefined ? undefined : FOREIGN_KEYS[constraint]?.()) ??
        new ResourceInUseError('another record still references this one', constraint ?? 'unknown')
      );

    case 'P2025':
      return new ResourceNotFoundError(resourceOf(error));

    case 'P2039': {
      const known = constraint === undefined ? undefined : CHECK_CONSTRAINTS[constraint];

      // An unrecognised CHECK is still not an excuse to forward the driver's
      // text. The caller gets the constraint's name, which is safe, and
      // nothing from the row that failed.
      return new ValidationFailedError([
        known ?? {
          field: constraint ?? 'request',
          message: 'the value violates a database constraint',
        },
      ]);
    }

    default:
      return undefined;
  }
}

function checkConstraintName(message: string | undefined): string | undefined {
  return /violates check constraint "([^"]+)"/.exec(message ?? '')?.[1];
}

function resourceOf(error: PrismaLikeError): string {
  const model = error.meta?.modelName;
  return typeof model === 'string' && model.length > 0 ? model.toLowerCase() : 'resource';
}
