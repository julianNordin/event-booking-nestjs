import type { Event } from '../generated/prisma/client';
import { EventResponseDto } from './dto/event-response.dto';

/** How many registrations an event holds, by the two states that occupy a place. */
export interface EventCounts {
  confirmed: number;
  waitlisted: number;
}

/**
 * The single place a database row becomes a response body.
 *
 * Every field is listed explicitly rather than spread. That is the point: a
 * column added to the table has to be added here before a client can see it,
 * so a migration cannot widen the public API by accident.
 */
export function toEventResponse(event: Event, counts: EventCounts): EventResponseDto {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    venue: event.venue,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    capacity: event.capacity,
    waitlistEnabled: event.waitlistEnabled,
    registrationOpensAt: event.registrationOpensAt?.toISOString() ?? null,
    registrationClosesAt: event.registrationClosesAt?.toISOString() ?? null,
    status: event.status,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    confirmedCount: counts.confirmed,
    waitlistCount: counts.waitlisted,
    availableSeats: Math.max(event.capacity - counts.confirmed, 0),
  };
}
