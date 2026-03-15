/**
 * The API's own vocabulary for where a registration stands.
 *
 * Declared here rather than re-exported from the generated Prisma client, for
 * the same reason `EventStatus` is: the wire contract and the column type are
 * two things that agree today, and sharing the symbol drags a Prisma import
 * into every DTO and controller that mentions a status.
 */
export const REGISTRATION_STATUSES = ['CONFIRMED', 'WAITLISTED', 'CANCELLED'] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** The two states that occupy a place — a seat or a spot in the queue. */
export const ACTIVE_REGISTRATION_STATUSES = ['CONFIRMED', 'WAITLISTED'] as const;

export function isActive(status: RegistrationStatus): boolean {
  return (ACTIVE_REGISTRATION_STATUSES as readonly string[]).includes(status);
}
