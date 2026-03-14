import {
  AlreadyExistsError,
  ResourceInUseError,
  ResourceNotFoundError,
  ValidationFailedError,
} from '../../src/common/errors/domain-error';
import { mapPrismaError } from '../../src/common/filters/prisma-error.mapper';
import { createAttendee, createEvent, createRegistration } from '../support/factories';
import { testPrisma } from '../support/prisma';

const prisma = testPrisma();

/**
 * The mapper's unit tests run against fixtures. This runs against the database.
 *
 * Fixtures are only as good as the moment they were copied: a Prisma upgrade
 * that moves the constraint name one level in the error object would leave
 * every unit test passing and the running service answering 409 with no idea
 * what conflicted. These tests provoke the real failures and feed the real
 * errors through the real mapper, so the two cannot drift apart quietly.
 */
async function raise(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected the database to reject this write');
}

describe('mapping errors the database actually produced', () => {
  it('maps a duplicate active registration to a 409 that names the rule', async () => {
    const event = await createEvent();
    const attendee = await createAttendee();
    await createRegistration({ eventId: event.id, attendeeId: attendee.id });

    const raw = await raise(() =>
      createRegistration({ eventId: event.id, attendeeId: attendee.id }),
    );
    const mapped = mapPrismaError(raw);

    expect(mapped).toBeInstanceOf(AlreadyExistsError);
    expect(mapped?.status).toBe(409);
    expect(mapped?.message).toMatch(/already holds an active registration/);
    expect(mapped?.extensions()).toEqual({ conflictingOn: 'eventId+attendeeId' });
  });

  it('maps a duplicate email to a different 409 than a duplicate registration', async () => {
    await createAttendee({ email: 'ada@example.com' });

    const raw = await raise(() => createAttendee({ email: 'ADA@example.com' }));
    const mapped = mapPrismaError(raw);

    expect(mapped).toBeInstanceOf(AlreadyExistsError);
    expect(mapped?.extensions()).toEqual({ conflictingOn: 'email' });
    expect(mapped?.message).toMatch(/email address already exists/);
  });

  it('maps a RESTRICT violation to a 409 naming what holds the reference', async () => {
    const event = await createEvent();
    const attendee = await createAttendee();
    await createRegistration({ eventId: event.id, attendeeId: attendee.id });

    const raw = await raise(() => prisma.attendee.delete({ where: { id: attendee.id } }));
    const mapped = mapPrismaError(raw);

    expect(mapped).toBeInstanceOf(ResourceInUseError);
    expect(mapped?.status).toBe(409);
    expect(mapped?.extensions()).toEqual({ referencedBy: 'registrations' });
  });

  it('maps a missing record to a 404', async () => {
    const raw = await raise(() =>
      prisma.event.update({
        where: { id: '0195e3a0-0000-7000-8000-0000deadbeef' },
        data: { title: 'nope' },
      }),
    );
    const mapped = mapPrismaError(raw);

    expect(mapped).toBeInstanceOf(ResourceNotFoundError);
    expect(mapped?.status).toBe(404);
    expect(mapped?.extensions()).toEqual({ resource: 'event' });
  });

  it.each([
    ['ck_events_capacity', { capacity: 0 }, 'capacity'],
    ['ck_events_ends_after', { endsAt: new Date(Date.now() + 1000) }, 'endsAt'],
  ])('maps a %s violation to a 400 naming the field', async (_constraint, overrides, field) => {
    const raw = await raise(() =>
      createEvent({ startsAt: new Date(Date.now() + 86_400_000), ...overrides }),
    );
    const mapped = mapPrismaError(raw);

    expect(mapped).toBeInstanceOf(ValidationFailedError);
    expect(mapped?.status).toBe(400);
    expect((mapped as ValidationFailedError).errors[0]?.field).toBe(field);
  });

  it('never carries the failing row out of a real check violation', async () => {
    // The live version of the leak test. PostgreSQL puts every column of the
    // rejected row into this message, so the title below would travel to the
    // client if the mapper ever forwarded it.
    const raw = await raise(() =>
      createEvent({ title: 'Confidential Board Offsite', capacity: 0 }),
    );
    const mapped = mapPrismaError(raw);

    const rendered = JSON.stringify({
      message: mapped?.message,
      extensions: mapped?.extensions(),
    });

    expect(rendered).not.toMatch(/Confidential Board Offsite/);
    expect(rendered).not.toMatch(/Failing row/);
  });
});
