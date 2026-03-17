import { Test } from '@nestjs/testing';

import { Clock, SystemClock } from './clock.service';

describe('SystemClock', () => {
  it('reports the current time', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('returns a fresh Date each call rather than a cached one', () => {
    const clock = new SystemClock();

    expect(clock.now()).not.toBe(clock.now());
  });
});

describe('Clock as a DI token', () => {
  it('resolves to the system clock by default', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: Clock, useClass: SystemClock }],
    }).compile();

    expect(moduleRef.get(Clock)).toBeInstanceOf(SystemClock);
  });

  it('can be replaced wholesale by a fixed clock', async () => {
    // The whole point. Freezing time is a provider override, not a global mock,
    // so a test can state the instant it cares about and nothing else changes.
    const frozen = new Date('2027-06-01T12:00:00.000Z');

    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: Clock, useValue: { now: () => frozen } }],
    }).compile();

    expect(moduleRef.get(Clock).now()).toBe(frozen);
  });
});
