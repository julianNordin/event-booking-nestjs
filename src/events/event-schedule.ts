/**
 * The timing invariants of an event, as pure functions.
 *
 * `endsAt > startsAt` is also a CHECK constraint in the database. It is checked
 * here as well so the caller gets a 400 naming the field instead of a driver
 * error, and checked there as well because the service is not the only writer.
 * The other two rules are only expressible here: they involve nullable columns
 * whose relationship SQL would need a more awkward CHECK to state, and they are
 * validation rather than corruption-prevention.
 */
export interface EventSchedule {
  startsAt: Date;
  endsAt: Date;
  registrationOpensAt?: Date | null;
  registrationClosesAt?: Date | null;
}

export interface ScheduleViolation {
  field: string;
  message: string;
}

export function validateSchedule(schedule: EventSchedule): ScheduleViolation[] {
  const violations: ScheduleViolation[] = [];
  const { startsAt, endsAt, registrationOpensAt, registrationClosesAt } = schedule;

  // Strictly after. An event that ends at the instant it starts has no
  // duration, and every "is it running now" comparison excludes it.
  if (endsAt.getTime() <= startsAt.getTime()) {
    violations.push({
      field: 'endsAt',
      message: 'endsAt must be strictly after startsAt',
    });
  }

  if (registrationClosesAt != null && registrationClosesAt.getTime() > startsAt.getTime()) {
    // Registration open after the doors have opened means people booking a seat
    // at an event that has already begun.
    violations.push({
      field: 'registrationClosesAt',
      message: 'registrationClosesAt must be no later than startsAt',
    });
  }

  if (
    registrationOpensAt != null &&
    registrationClosesAt != null &&
    registrationOpensAt.getTime() >= registrationClosesAt.getTime()
  ) {
    violations.push({
      field: 'registrationOpensAt',
      message: 'registrationOpensAt must be before registrationClosesAt',
    });
  }

  // Only meaningful when there is no close time to have caught it already.
  if (
    registrationOpensAt != null &&
    registrationClosesAt == null &&
    registrationOpensAt.getTime() > startsAt.getTime()
  ) {
    violations.push({
      field: 'registrationOpensAt',
      message: 'registrationOpensAt must be no later than startsAt',
    });
  }

  return violations;
}
