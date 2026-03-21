import { EventStatus } from '../event-status';

/**
 * What a client actually receives. Declared separately from the Prisma model
 * on purpose: a column added to the table should not silently appear in the
 * public response, and a field renamed on the wire should not force a
 * migration.
 *
 * Timestamps are ISO-8601 strings rather than Dates. JSON has no date type, so
 * this is what goes over the wire either way — saying so in the type means the
 * conversion happens once, in the mapper, where it can be tested.
 */
export class EventResponseDto {
  id!: string;
  title!: string;
  description!: string | null;
  venue!: string;
  startsAt!: string;
  endsAt!: string;
  capacity!: number;
  waitlistEnabled!: boolean;
  registrationOpensAt!: string | null;
  registrationClosesAt!: string | null;
  status!: EventStatus;
  createdAt!: string;
  updatedAt!: string;

  /** How many people currently hold a seat. */
  confirmedCount!: number;

  /** How many are waiting for one. */
  waitlistCount!: number;

  /**
   * Seats still to be had. Never negative: an overbooked event has none, it
   * does not have minus two.
   */
  availableSeats!: number;
}
