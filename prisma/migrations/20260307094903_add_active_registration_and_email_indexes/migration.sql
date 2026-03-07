-- Written by hand. Prisma's schema language has no partial index and no
-- functional index, so neither of these can be expressed in schema.prisma and
-- both would be lost by `prisma db push`, which is banned in this repository
-- for exactly that reason.

-- One ACTIVE registration per attendee per event.
--
-- The predicate is what makes this correct rather than merely unique. A plain
-- unique index on (event_id, attendee_id) would also stop someone who cancelled
-- from ever registering again, because the cancelled row keeps occupying the
-- pair. Excluding CANCELLED means the constraint holds for everyone who
-- currently has a seat or a waitlist place, and says nothing about history.
CREATE UNIQUE INDEX "ux_registration_active"
  ON "registrations" ("event_id", "attendee_id")
  WHERE "status" <> 'CANCELLED';

-- Ada@example.com and ada@example.com are one person.
--
-- Addresses are normalised at the API boundary, but normalisation is a rule
-- that lives in application code and can be bypassed by a seed script, a
-- migration, a fixture, or the next endpoint someone adds. This index is the
-- version of the rule that cannot be bypassed.
CREATE UNIQUE INDEX "ux_attendees_email_lower"
  ON "attendees" (lower("email"));
