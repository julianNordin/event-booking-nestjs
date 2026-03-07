-- Written by hand: Prisma's schema language has no CHECK constraint.
--
-- Both of these are also enforced in the service layer, where they produce a
-- readable 400 naming the field. They are duplicated here because the service
-- layer is not the only writer — seeds, migrations and future endpoints all
-- reach the same tables, and an invariant that only one code path honours is
-- not an invariant.

-- A zero-capacity event is not a sold-out event, it is a data-entry mistake:
-- the registration rules would compute "0 confirmed of 0 seats" and waitlist
-- every single person forever.
ALTER TABLE "events"
  ADD CONSTRAINT "ck_events_capacity" CHECK ("capacity" >= 1);

-- Strictly greater, not >=. An event that ends at the instant it starts has
-- no duration, and every "is this event running now" comparison silently
-- excludes it.
ALTER TABLE "events"
  ADD CONSTRAINT "ck_events_ends_after" CHECK ("ends_at" > "starts_at");
