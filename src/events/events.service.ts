import { Injectable, Logger } from '@nestjs/common';

import { PagedResponse } from '../common/dto/paged-response';
import { clampPageSize, parseSort, SortOrder, toSkip } from '../common/dto/sort';

import {
  ResourceNotFoundError,
  RuleViolationError,
  TransitionNotAllowedError,
  ValidationFailedError,
} from '../common/errors/domain-error';
import type { Event as PrismaEvent, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { OrganiserIdentity } from '../config/security.config';
import { WaitlistService } from '../registrations/waitlist.service';
import { CreateEventDto } from './dto/create-event.dto';
import { EventResponseDto } from './dto/event-response.dto';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventCounts, toEventResponse } from './event.mapper';
import { EventSchedule, validateSchedule } from './event-schedule';
import { applyAction, canDelete, EventAction } from './event-status';

/**
 * The columns a client may sort by.
 *
 * Everything here is already visible in the response. That is the rule: a sort
 * field is a read primitive, and one that is not in the response body lets a
 * caller order by a hidden value and recover it by bisection.
 */
export const EVENT_SORT_FIELDS = ['startsAt', 'endsAt', 'title', 'capacity', 'createdAt'] as const;

const DEFAULT_EVENT_SORT: SortOrder[] = [{ field: 'startsAt', direction: 'asc' }];

/** An event nobody has registered for. Shared so it is never rebuilt per row. */
const EMPTY_COUNTS: EventCounts = { confirmed: 0, waitlisted: 0 };

@Injectable()
export class EventsService {
  /**
   * Stated rather than inherited, and matching the registration path. An edit
   * queues behind whatever registrations hold the event's lock, and Prisma's
   * 2s default would start failing edits on the clock during a busy minute.
   */
  private static readonly TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 10_000 };

  private readonly logger = new Logger(EventsService.name);

  /**
   * Records who changed an event, and how.
   *
   * The organiser identity comes from the guard by way of `@Organiser()`, so
   * every state change on an event is attributable. It is written to the log
   * and never to a response: which organiser owns an event is not something the
   * public listing should disclose.
   *
   * The actor is optional in this signature and always supplied by the
   * controller. Optional because the service is also reachable from a seed
   * script and from tests, where there is no organiser and inventing one would
   * put a fictional name in an audit trail.
   */
  private audit(action: string, eventId: string, actor?: OrganiserIdentity): void {
    this.logger.log(`event ${eventId} ${action} by ${actor?.name ?? 'an unattributed caller'}`);
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly waitlist: WaitlistService,
  ) {}

  async findAll(
    query: ListEventsQueryDto = new ListEventsQueryDto(),
  ): Promise<PagedResponse<EventResponseDto>> {
    const size = clampPageSize(query.size);
    const page = query.page;

    // Validated here rather than in a pipe, so the rule holds for every caller
    // of the service and not merely for every caller that arrives over HTTP.
    const orderBy = parseSort(query.sort, EVENT_SORT_FIELDS, DEFAULT_EVENT_SORT).map((order) => ({
      [order.field]: order.direction,
    }));

    const where = buildWhere(query);

    // One transaction, so the count and the page agree. Run separately, a write
    // landing between them produces "showing 20 of 19", which is the kind of
    // thing that gets reported as a rendering bug.
    const [events, totalItems] = await this.prisma.$transaction([
      this.prisma.event.findMany({ where, orderBy, skip: toSkip(page, size), take: size }),
      this.prisma.event.count({ where }),
    ]);

    // One grouped query for the whole page, not one per event.
    const counts = await this.countsForMany(events.map((event) => event.id));

    const counted = events.map((event) =>
      toEventResponse(event, counts.get(event.id) ?? EMPTY_COUNTS),
    );

    return PagedResponse.of(counted, page, size, totalItems);
  }

  async findOne(id: string): Promise<EventResponseDto> {
    const event = await this.prisma.event.findUnique({ where: { id } });

    if (event === null) {
      throw new ResourceNotFoundError('event', id);
    }

    return toEventResponse(event, await this.countsFor(id));
  }

  async create(dto: CreateEventDto, actor?: OrganiserIdentity): Promise<EventResponseDto> {
    this.assertScheduleIsCoherent(dto);

    const event = await this.prisma.event.create({
      // Written out field by field rather than spread. The DTO is shaped by the
      // wire contract and the row by the schema; they agree today, and a
      // spread would let tomorrow's divergence through silently.
      data: {
        title: dto.title,
        description: dto.description ?? null,
        venue: dto.venue,
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
        capacity: dto.capacity,
        waitlistEnabled: dto.waitlistEnabled ?? true,
        registrationOpensAt: dto.registrationOpensAt ?? null,
        registrationClosesAt: dto.registrationClosesAt ?? null,
        // status is not settable. Every event starts as a draft and leaves only
        // through the state machine.
      },
    });

    this.audit('created', event.id, actor);

    // A brand-new event holds nothing, so this needs no queries to establish.
    return toEventResponse(event, { confirmed: 0, waitlisted: 0 });
  }

  /**
   * Edit an event, and serve the queue if the edit made room.
   *
   * The whole thing runs inside a transaction holding the event's row lock —
   * the same lock registration and cancellation take. Two reasons, and the
   * second is the one that matters:
   *
   * - Raising capacity frees seats, and free seats are owed to whoever is
   *   already waiting. Promoting outside the lock would race a registration
   *   arriving at the same moment, and the newcomer would take a seat the queue
   *   had been waiting for.
   * - The check that capacity is not cut below the confirmed count used to be a
   *   read followed by a write, and therefore advisory: a registration could
   *   land between the two. Under the lock it is not advisory any more, because
   *   a registration cannot land in between.
   */
  async update(
    id: string,
    dto: UpdateEventDto,
    actor?: OrganiserIdentity,
  ): Promise<EventResponseDto> {
    const { updated, promoted } = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM events WHERE id = ${id}::uuid FOR UPDATE
        `;

      if (locked.length === 0) {
        throw new ResourceNotFoundError('event', id);
      }

      const existing = await tx.event.findUniqueOrThrow({ where: { id } });

      if (existing.status === 'CANCELLED') {
        throw new TransitionNotAllowedError(
          'a cancelled event is the record of something called off and cannot be edited',
          'CANCELLED',
          'update',
        );
      }

      // The schedule rules apply to the event as it will be, not to the
      // fields that happen to be in this request. Patching only endsAt has to
      // be checked against the stored startsAt, or an event can be walked
      // into an invalid state one field at a time.
      this.assertScheduleIsCoherent({
        startsAt: dto.startsAt ?? existing.startsAt,
        endsAt: dto.endsAt ?? existing.endsAt,
        registrationOpensAt:
          dto.registrationOpensAt === undefined
            ? existing.registrationOpensAt
            : dto.registrationOpensAt,
        registrationClosesAt:
          dto.registrationClosesAt === undefined
            ? existing.registrationClosesAt
            : dto.registrationClosesAt,
      });

      if (dto.capacity !== undefined && dto.capacity < existing.capacity) {
        const confirmed = await tx.registration.count({
          where: { eventId: id, status: 'CONFIRMED' },
        });

        if (dto.capacity < confirmed) {
          throw new RuleViolationError(
            `capacity cannot be reduced to ${String(dto.capacity)}: ${String(confirmed)} attendees already hold a confirmed seat`,
            'capacity-covers-confirmed',
            { requested: dto.capacity, confirmed },
          );
        }
      }

      const row = await tx.event.update({
        where: { id },
        // undefined means "leave this column alone" to Prisma and null means
        // "set it to null", which is exactly the distinction PATCH needs: an
        // absent field is untouched, an explicit null clears it.
        data: {
          title: dto.title,
          description: dto.description,
          venue: dto.venue,
          startsAt: dto.startsAt,
          endsAt: dto.endsAt,
          capacity: dto.capacity,
          waitlistEnabled: dto.waitlistEnabled,
          registrationOpensAt: dto.registrationOpensAt,
          registrationClosesAt: dto.registrationClosesAt,
        },
      });

      const grewCapacity = dto.capacity !== undefined && dto.capacity > existing.capacity;

      return {
        updated: row,
        promoted: grewCapacity ? await this.waitlist.promote(tx, id) : [],
      };
    }, EventsService.TRANSACTION_OPTIONS);

    // After the commit, never inside it.
    this.waitlist.announce(promoted);
    this.audit('updated', id, actor);

    return toEventResponse(updated, await this.countsFor(updated.id));
  }

  publish(id: string, actor?: OrganiserIdentity): Promise<EventResponseDto> {
    return this.runAction(id, 'publish', actor);
  }

  cancel(id: string, actor?: OrganiserIdentity): Promise<EventResponseDto> {
    return this.runAction(id, 'cancel', actor);
  }

  async remove(id: string, actor?: OrganiserIdentity): Promise<void> {
    const existing = await this.requireEvent(id);
    const outcome = canDelete(existing.status);

    if (!outcome.allowed) {
      throw new TransitionNotAllowedError(outcome.reason, existing.status, 'delete');
    }

    await this.prisma.event.delete({ where: { id } });
    this.audit('deleted', id, actor);
  }

  /**
   * Runs one transition of the state machine.
   *
   * The decision itself is the pure `applyAction`; everything here is the I/O
   * around it. That separation is what lets every status and action pair be
   * covered without a database, leaving these tests to cover only the parts
   * that genuinely need one.
   */
  private async runAction(
    id: string,
    action: EventAction,
    actor?: OrganiserIdentity,
  ): Promise<EventResponseDto> {
    const existing = await this.requireEvent(id);
    const outcome = applyAction(existing.status, action);

    if (!outcome.allowed) {
      throw new TransitionNotAllowedError(outcome.reason, existing.status, action);
    }

    if (outcome.to !== 'CANCELLED') {
      const updated = await this.prisma.event.update({
        where: { id },
        data: { status: outcome.to },
      });

      this.audit(`${action}ed`, id, actor);

      return toEventResponse(updated, await this.countsFor(updated.id));
    }

    // Cancelling an event cancels everyone's place in it, and the two must
    // happen together. Cancelling the event alone leaves rows that claim to be
    // confirmed seats at something that is not running; cancelling the
    // registrations alone loses the event's own status if the second write
    // fails. One transaction, or neither.
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.registration.updateMany({
        where: { eventId: id, status: { in: ['CONFIRMED', 'WAITLISTED'] } },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          // The queue is gone with the event; leaving positions behind would
          // have them re-used if the rows were ever revived.
          waitlistPosition: null,
        },
      });

      return tx.event.update({ where: { id }, data: { status: 'CANCELLED' } });
    });

    this.audit('cancelled', id, actor);

    return toEventResponse(updated, await this.countsFor(updated.id));
  }

  private async countsFor(eventId: string): Promise<EventCounts> {
    return (await this.countsForMany([eventId])).get(eventId) ?? EMPTY_COUNTS;
  }

  /**
   * Registration counts for many events, in **one** query.
   *
   * This replaced two counts per event. Measured on a page of ten events, with
   * the query-counting client extension:
   *
   *     before   22 queries   (2 for the page and its total, then 2 per event)
   *     after     3 queries   (page, total, and this one)
   *
   * The number that matters is not three. It is that listing five events and
   * listing ten now cost the same, which is what the performance test asserts —
   * a magic number goes stale the first time a legitimate query is added, and
   * says nothing about whether the cost grows with the data.
   *
   * groupBy rather than a filtered `_count` include, because two counts are
   * needed per event and a relation count can carry only one filter. One
   * grouped query returns both, and says plainly what it is doing.
   */
  private async countsForMany(eventIds: string[]): Promise<Map<string, EventCounts>> {
    const counts = new Map<string, EventCounts>(
      eventIds.map((id) => [id, { confirmed: 0, waitlisted: 0 }]),
    );

    if (eventIds.length === 0) {
      return counts;
    }

    const grouped = await this.prisma.registration.groupBy({
      by: ['eventId', 'status'],
      where: { eventId: { in: eventIds }, status: { in: ['CONFIRMED', 'WAITLISTED'] } },
      _count: { _all: true },
    });

    for (const row of grouped) {
      const entry = counts.get(row.eventId);

      if (entry === undefined) {
        continue;
      }

      if (row.status === 'CONFIRMED') {
        entry.confirmed = row._count._all;
      } else {
        entry.waitlisted = row._count._all;
      }
    }

    return counts;
  }

  private async requireEvent(id: string): Promise<PrismaEvent> {
    const event = await this.prisma.event.findUnique({ where: { id } });

    if (event === null) {
      throw new ResourceNotFoundError('event', id);
    }

    return event;
  }

  /**
   * Turns schedule violations into a 400 that names each offending field.
   *
   * endsAt > startsAt is also a CHECK constraint. Reaching the database and
   * letting it refuse would be correct but useless to the caller: the driver
   * error names a constraint, not a field, and carries the entire failing row.
   */
  private assertScheduleIsCoherent(schedule: EventSchedule): void {
    const violations = validateSchedule(schedule);

    if (violations.length > 0) {
      throw new ValidationFailedError(violations);
    }
  }
}

/**
 * Translates the query parameters into a Prisma filter.
 *
 * A free function rather than a method: it touches no state, and keeping it out
 * of the class makes it obvious that adding a filter cannot accidentally reach
 * for the database.
 */
function buildWhere(query: ListEventsQueryDto): Prisma.EventWhereInput {
  const where: Prisma.EventWhereInput = {};

  if (query.status !== undefined) {
    where.status = query.status;
  }

  // Substring and case-insensitive: a venue filter people type by hand is worth
  // very little if it demands the exact stored string.
  if (query.venue !== undefined && query.venue !== '') {
    where.venue = { contains: query.venue, mode: 'insensitive' };
  }

  if (query.from !== undefined || query.to !== undefined) {
    where.startsAt = {
      ...(query.from === undefined ? {} : { gte: query.from }),
      ...(query.to === undefined ? {} : { lte: query.to }),
    };
  }

  if (query.q !== undefined && query.q !== '') {
    // OR inside the top-level object, so this is ANDed with every other filter:
    // a search combined with a status must satisfy both.
    where.OR = [
      { title: { contains: query.q, mode: 'insensitive' } },
      { description: { contains: query.q, mode: 'insensitive' } },
    ];
  }

  return where;
}
