import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';

import { ListEventsQueryDto } from '../../src/events/dto/list-events-query.dto';
import { EventsService } from '../../src/events/events.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { QueryCounter, withQueryCounter } from '../../src/prisma/query-counter';
import { WaitlistService } from '../../src/registrations/waitlist.service';
import { createAttendee, createEvent, createRegistration } from '../support/factories';
import { testPrisma } from '../support/prisma';

/**
 * How many queries listing events actually costs.
 *
 * "Is there an N+1 here" is a question with a number for an answer, and reading
 * the service to guess at it is how N+1s survive review. The Prisma client
 * extension counts every model operation, so nothing can quietly avoid being
 * counted, and these tests assert on the number.
 */
describe('query counts for listing events', () => {
  let service: EventsService;
  let counter: QueryCounter;

  beforeAll(async () => {
    const { client, counter: queryCounter } = withQueryCounter(testPrisma());
    counter = queryCounter;

    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        WaitlistService,
        EventEmitter2,
        { provide: PrismaService, useValue: client },
      ],
    }).compile();

    service = moduleRef.get(EventsService);
  });

  /** `count` events, each holding one confirmed and one waitlisted registration. */
  async function seedEvents(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const event = await createEvent({ capacity: 1, title: `Event ${String(i)}` });
      const [confirmed, waiting] = await Promise.all([createAttendee(), createAttendee()]);

      await createRegistration({ eventId: event.id, attendeeId: confirmed.id });
      await createRegistration({
        eventId: event.id,
        attendeeId: waiting.id,
        status: 'WAITLISTED',
        waitlistPosition: 1,
      });
    }
  }

  async function queriesToList(events: number): Promise<number> {
    await seedEvents(events);
    counter.reset();

    const page = await service.findAll(
      Object.assign(new ListEventsQueryDto(), { page: 1, size: 50 }),
    );
    expect(page.items).toHaveLength(events);

    return counter.total;
  }

  it('reports the counts it promised', async () => {
    await seedEvents(1);
    counter.reset();

    const page = await service.findAll(new ListEventsQueryDto());

    expect(page.items[0]).toMatchObject({
      capacity: 1,
      confirmedCount: 1,
      waitlistCount: 1,
      availableSeats: 0,
    });
  });

  it('costs the same number of queries for five events as for ten', async () => {
    // The assertion that defines "no N+1", and the reason it is phrased this
    // way rather than as a magic number: what matters is not that listing costs
    // three queries, it is that the cost does not grow with the number of rows.
    // A magic number also goes stale the moment a legitimate query is added.
    const five = await queriesToList(5);

    // The harness truncates between tests, so this starts from empty again.
    await testPrisma().registration.deleteMany();
    await testPrisma().event.deleteMany();
    await testPrisma().attendee.deleteMany();

    const ten = await queriesToList(10);

    expect(ten).toBe(five);
  });

  it('does not issue one count per event', async () => {
    // The specific shape of the N+1, named. If this ever regresses, the failure
    // message says which model and operation ran too many times.
    await seedEvents(8);
    counter.reset();

    await service.findAll(Object.assign(new ListEventsQueryDto(), { page: 1, size: 50 }));

    expect(counter.countOf('Registration', 'count')).toBeLessThan(8);
  });

  it('reads a single event without a query per relation', async () => {
    const event = await createEvent({ capacity: 5 });
    const attendee = await createAttendee();
    await createRegistration({ eventId: event.id, attendeeId: attendee.id });
    counter.reset();

    const found = await service.findOne(event.id);

    expect(found.confirmedCount).toBe(1);
    expect(counter.total).toBeLessThanOrEqual(2);
  });
});
