/**
 * Fires N simultaneous registrations at a one-seat event and reports what came
 * back — against a running server, over real HTTP.
 *
 *   npm run start:dev            # in one terminal
 *   npm run check:overbook       # in another
 *
 * The integration suite already proves this, in-process and against a
 * Testcontainers database. This exists because the two are not the same claim:
 * here the requests cross a socket, go through the global pipe and filter, and
 * contend for the same connection pool the real service uses. It is also the
 * form the result can be shown in without asking anyone to read a test.
 *
 * Every outcome is classified, including the failures and *why* they failed. A
 * script that only counted confirmations would call a pool timeout a success.
 */
const BASE = process.env.API_BASE ?? 'http://localhost:3000/api/v1';
const CONTENDERS = Number(process.env.CONTENDERS ?? 20);
const API_KEY = process.env.API_KEY;

const DAY = 24 * 60 * 60 * 1000;

interface Json {
  [key: string]: unknown;
}

async function call(method: string, path: string, body?: Json): Promise<Json> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(API_KEY === undefined ? {} : { 'x-api-key': API_KEY }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload: unknown = text === '' ? {} : JSON.parse(text);

  if (!response.ok) {
    throw Object.assign(new Error(`${method} ${path} -> ${String(response.status)}`), {
      status: response.status,
      problem: payload as Json,
    });
  }

  return payload as Json;
}

interface Outcome {
  label: string;
}

function classify(error: unknown): Outcome {
  const problem = (error as { problem?: { rule?: unknown; type?: unknown; detail?: unknown } })
    .problem;
  const rule = problem?.rule;

  if (typeof rule === 'string') {
    return { label: `refused: ${rule}` };
  }

  const type = typeof problem?.type === 'string' ? problem.type : 'unknown';
  const detail = typeof problem?.detail === 'string' ? problem.detail : 'no detail';

  return { label: `failed: ${type} (${detail})` };
}

async function main(): Promise<void> {
  const startsAt = new Date(Date.now() + 30 * DAY);

  const event = await call('POST', '/events', {
    title: `Overbook check ${new Date().toISOString()}`,
    venue: 'Concurrency Hall',
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    capacity: 1,
    waitlistEnabled: false,
  });

  const eventId = String(event.id);
  await call('POST', `/events/${eventId}/publish`);

  const attendees = await Promise.all(
    Array.from({ length: CONTENDERS }, (_, index) =>
      call('POST', '/attendees', {
        email: `overbook-${String(Date.now())}-${String(index)}@example.com`,
        name: `Contender ${String(index)}`,
      }),
    ),
  );

  console.log(`firing ${String(CONTENDERS)} simultaneous registrations at a 1-seat event…\n`);
  const startedAt = Date.now();

  const outcomes = await Promise.all(
    attendees.map(async (attendee): Promise<Outcome> => {
      try {
        const registration = await call('POST', `/events/${eventId}/registrations`, {
          attendeeId: attendee.id,
        });
        return { label: String(registration.status) };
      } catch (error) {
        return classify(error);
      }
    }),
  );

  const elapsed = Date.now() - startedAt;

  const tally = new Map<string, number>();
  for (const outcome of outcomes) {
    tally.set(outcome.label, (tally.get(outcome.label) ?? 0) + 1);
  }

  for (const [label, count] of [...tally].sort()) {
    console.log(`  ${String(count).padStart(3)}  ${label}`);
  }

  const roster = (await call('GET', `/events/${eventId}/registrations`)) as unknown as {
    status: string;
  }[];
  const confirmed = roster.filter((registration) => registration.status === 'CONFIRMED').length;

  console.log(`\n  ${String(elapsed)}ms total`);
  console.log(`  confirmed in the database: ${String(confirmed)}`);

  if (confirmed !== 1) {
    console.error(`\nOVERBOOKED: expected exactly 1 confirmed, found ${String(confirmed)}`);
    process.exit(1);
  }

  const wrongReason = [...tally.keys()].filter(
    (label) => label !== 'CONFIRMED' && label !== 'refused: event-full',
  );

  if (wrongReason.length > 0) {
    // One confirmed is not enough on its own: if the others died on a pool or
    // transaction timeout, the seat was protected by exhaustion rather than by
    // the rule, and that is not the same service.
    console.error(
      `\nWRONG REASON: some requests did not fail on capacity: ${wrongReason.join(', ')}`,
    );
    process.exit(1);
  }

  console.log('\nexactly one seat sold, and every refusal was the capacity rule.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
