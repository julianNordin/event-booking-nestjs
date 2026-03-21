import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';

import { Clock, SystemClock } from '../../src/common/clock/clock.service';
import { RuleViolationError } from '../../src/common/errors/domain-error';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RegistrationsService } from '../../src/registrations/registrations.service';
import { WaitlistService } from '../../src/registrations/waitlist.service';
import { createAttendee, createEvent } from '../support/factories';
import { testPrisma } from '../support/prisma';

const prisma = testPrisma();

/** How many people rush the door at once. */
const CONTENDERS = 20;

interface Attempt {
  status: 'CONFIRMED' | 'WAITLISTED' | 'REFUSED';
  rule?: string;
  waitlistPosition?: number | null;
  error?: unknown;
}

describe('capacity under concurrent registration', () => {
  let service: RegistrationsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RegistrationsService,
        WaitlistService,
        EventEmitter2,
        { provide: PrismaService, useValue: testPrisma() },
        { provide: Clock, useClass: SystemClock },
      ],
    }).compile();

    service = moduleRef.get(RegistrationsService);
  });

  /**
   * Fire `CONTENDERS` registrations at one event simultaneously and classify
   * every outcome — including the failures, and *why* they failed.
   *
   * Counting only the confirmations is the trap this whole phase is about. If
   * ten requests never reached the database because the connection pool was
   * exhausted, or died on the interactive-transaction timeout, the confirmed
   * count is still one and the suite goes green for a reason that has nothing
   * to do with capacity.
   */
  async function stampede(eventId: string, count: number): Promise<Attempt[]> {
    const attendees = await Promise.all(Array.from({ length: count }, () => createAttendee()));

    return Promise.all(
      attendees.map(async (attendee): Promise<Attempt> => {
        try {
          const registration = await service.register(eventId, { attendeeId: attendee.id });
          return {
            status: registration.status === 'WAITLISTED' ? 'WAITLISTED' : 'CONFIRMED',
            waitlistPosition: registration.waitlistPosition,
          };
        } catch (error) {
          return {
            status: 'REFUSED',
            rule: error instanceof RuleViolationError ? error.rule : undefined,
            error,
          };
        }
      }),
    );
  }

  it('confirms exactly one attendee for a single seat', async () => {
    const event = await createEvent({ capacity: 1, waitlistEnabled: false });

    const attempts = await stampede(event.id, CONTENDERS);

    const confirmed = attempts.filter((attempt) => attempt.status === 'CONFIRMED');
    expect(confirmed).toHaveLength(1);

    // And the database agrees — the count above is what the service *said*,
    // this is what actually landed.
    await expect(
      prisma.registration.count({ where: { eventId: event.id, status: 'CONFIRMED' } }),
    ).resolves.toBe(1);
  });

  it('refuses every other attendee by the capacity rule, not by a timeout', async () => {
    // Gotcha 8, made an assertion. A pool timeout (P2024) or an interactive
    // transaction timeout (P2028) would also produce "one confirmed", and this
    // is what tells the two apart.
    const event = await createEvent({ capacity: 1, waitlistEnabled: false });

    const attempts = await stampede(event.id, CONTENDERS);
    const refused = attempts.filter((attempt) => attempt.status === 'REFUSED');

    expect(refused).toHaveLength(CONTENDERS - 1);
    for (const attempt of refused) {
      expect(attempt.rule).toBe('event-full');
    }
  });

  it('never lets confirmed registrations exceed capacity, at any size', async () => {
    const event = await createEvent({ capacity: 5, waitlistEnabled: false });

    await stampede(event.id, CONTENDERS);

    const confirmed = await prisma.registration.count({
      where: { eventId: event.id, status: 'CONFIRMED' },
    });

    expect(confirmed).toBe(5);
  });

  it('gives every waitlisted attendee a distinct position', async () => {
    // The same race one layer along: two transactions reading the same maximum
    // position hand out the same number twice.
    const event = await createEvent({ capacity: 1, waitlistEnabled: true });

    const attempts = await stampede(event.id, CONTENDERS);
    const waitlisted = attempts.filter((attempt) => attempt.status === 'WAITLISTED');

    expect(waitlisted).toHaveLength(CONTENDERS - 1);

    const positions = waitlisted.map((attempt) => attempt.waitlistPosition);
    expect(new Set(positions).size).toBe(positions.length);
    expect([...positions].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: CONTENDERS - 1 }, (_, index) => index + 1),
    );
  });

  it('serialises per event, so a rush on one does not block another', async () => {
    const [first, second] = await Promise.all([
      createEvent({ capacity: 1, waitlistEnabled: false }),
      createEvent({ capacity: 1, waitlistEnabled: false }),
    ]);

    const [firstAttempts, secondAttempts] = await Promise.all([
      stampede(first.id, 5),
      stampede(second.id, 5),
    ]);

    expect(firstAttempts.filter((attempt) => attempt.status === 'CONFIRMED')).toHaveLength(1);
    expect(secondAttempts.filter((attempt) => attempt.status === 'CONFIRMED')).toHaveLength(1);
  });
});
