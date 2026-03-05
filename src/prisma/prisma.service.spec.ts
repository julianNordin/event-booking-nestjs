import { PrismaPg } from '@prisma/adapter-pg';
import { Test } from '@nestjs/testing';

import { databaseConfig } from '../config/database.config';
import { PrismaService } from './prisma.service';

// PrismaClient inspects the adapter it is handed and refuses one whose
// provider does not match the schema, so the stub has to claim to be what the
// real factory claims to be.
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({
    provider: 'postgres',
    adapterName: '@prisma/adapter-pg',
    connect: jest.fn(),
    dispose: jest.fn(),
  })),
}));

const PrismaPgMock = PrismaPg as unknown as jest.Mock;

async function buildService(overrides: Partial<{ url: string; poolMax: number }> = {}) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      PrismaService,
      {
        provide: databaseConfig.KEY,
        useValue: {
          url: 'postgresql://injected:secret@db:5432/from_config',
          poolMax: 37,
          ...overrides,
        },
      },
    ],
  }).compile();

  return moduleRef;
}

describe('PrismaService', () => {
  beforeEach(() => {
    PrismaPgMock.mockClear();
  });

  it('builds its driver adapter from the injected configuration', async () => {
    const moduleRef = await buildService();
    moduleRef.get(PrismaService);

    expect(PrismaPgMock).toHaveBeenCalledTimes(1);
    expect(PrismaPgMock).toHaveBeenCalledWith({
      connectionString: 'postgresql://injected:secret@db:5432/from_config',
      max: 37,
    });

    await moduleRef.close();
  });

  it('does not read the connection string from process.env', async () => {
    // Prisma 7 stopped loading .env itself, and a process.env read here would
    // evaluate at module load — before ConfigModule has validated anything.
    // The resulting adapter error reads exactly like a Nest DI failure and
    // sends you looking in the wrong place entirely, so this is pinned down.
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://ambient:nope@localhost:5432/should_be_ignored';

    try {
      const moduleRef = await buildService({ url: 'postgresql://a:b@db:5432/wins' });
      moduleRef.get(PrismaService);

      expect(PrismaPgMock).toHaveBeenCalledWith(
        expect.objectContaining({ connectionString: 'postgresql://a:b@db:5432/wins' }),
      );
      await moduleRef.close();
    } finally {
      process.env.DATABASE_URL = previous;
    }
  });

  it('sizes the pool from configuration rather than the driver default', async () => {
    const moduleRef = await buildService({ poolMax: 5 });
    moduleRef.get(PrismaService);

    expect(PrismaPgMock).toHaveBeenCalledWith(expect.objectContaining({ max: 5 }));

    await moduleRef.close();
  });

  it('opens the pool on module init and closes it on destroy', async () => {
    const moduleRef = await buildService();
    const service = moduleRef.get(PrismaService);

    const connect = jest.spyOn(service, '$connect').mockResolvedValue(undefined);
    const disconnect = jest.spyOn(service, '$disconnect').mockResolvedValue(undefined);

    await service.onModuleInit();
    expect(connect).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });
});
