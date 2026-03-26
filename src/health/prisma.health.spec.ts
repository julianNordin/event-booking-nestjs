import { HealthIndicatorService } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { PrismaHealthIndicator } from './prisma.health';

interface Result {
  database: { status: string; reason?: string };
}

describe('PrismaHealthIndicator', () => {
  const queryRaw = jest.fn();
  let indicator: PrismaHealthIndicator;

  beforeEach(async () => {
    queryRaw.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        PrismaHealthIndicator,
        HealthIndicatorService,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
      ],
    }).compile();

    indicator = moduleRef.get(PrismaHealthIndicator);
  });

  it('reports up when the database answers', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const result = (await indicator.pingCheck('database')) as unknown as Result;

    expect(result.database.status).toBe('up');
  });

  it('reports down when it does not', async () => {
    queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7:5432'));

    const result = (await indicator.pingCheck('database')) as unknown as Result;

    expect(result.database.status).toBe('down');
  });

  it('does not put the connection error into the response', async () => {
    // /health is the most reliably unauthenticated endpoint on any service, and
    // a driver error carries a host, a port and sometimes a password.
    queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7:5432 password=hunter2'));

    const result = (await indicator.pingCheck('database')) as unknown as Result;
    const rendered = JSON.stringify(result);

    expect(rendered).not.toMatch(/ECONNREFUSED/);
    expect(rendered).not.toMatch(/hunter2/);
    expect(rendered).not.toMatch(/10\.0\.0\.7/);
    expect(result.database.reason).toBe('Error');
  });

  it('uses the cheapest query there is', async () => {
    // A health check runs on a timer. One that costs real work becomes load of
    // its own, and the first thing to fall over under pressure.
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    await indicator.pingCheck('database');

    const [template] = queryRaw.mock.calls[0] as [TemplateStringsArray];
    expect(template.join('').trim()).toBe('SELECT 1');
  });

  it('recovers on its own once the database comes back', async () => {
    // Nothing is cached and no state is kept, so the next call simply asks
    // again. A health check that latches on failure needs a restart to clear,
    // which is the opposite of what it is for.
    queryRaw.mockRejectedValueOnce(new Error('down'));
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const first = (await indicator.pingCheck('database')) as unknown as Result;
    const second = (await indicator.pingCheck('database')) as unknown as Result;

    expect(first.database.status).toBe('down');
    expect(second.database.status).toBe('up');
  });
});
