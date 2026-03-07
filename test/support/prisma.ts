import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client';

let client: PrismaClient | undefined;

/**
 * One client per worker, built lazily so it picks up the DATABASE_URL that
 * global setup published after starting the container.
 *
 * Constructing it at module load instead would capture the value from before
 * the container existed, which is the same shape of bug as reading process.env
 * inside PrismaService.
 */
export function testPrisma(): PrismaClient {
  if (client === undefined) {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString === undefined || connectionString === '') {
      throw new Error(
        'DATABASE_URL is not set. The integration tier gets it from global setup; ' +
          'this usually means the container failed to start.',
      );
    }

    client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }

  return client;
}

export async function disconnectTestPrisma(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
