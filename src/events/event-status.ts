/**
 * The API's own vocabulary for an event's lifecycle.
 *
 * Structurally identical to the Prisma enum today, and deliberately declared
 * separately: the wire contract and the column type are two different things
 * that happen to agree. Re-exporting the generated enum would make every
 * consumer of this module — controllers, DTOs, the state machine — import from
 * the Prisma client, which is the coupling the layering exists to prevent.
 */
export const EVENT_STATUSES = ['DRAFT', 'PUBLISHED', 'CANCELLED'] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

export function isEventStatus(value: unknown): value is EventStatus {
  return typeof value === 'string' && (EVENT_STATUSES as readonly string[]).includes(value);
}
