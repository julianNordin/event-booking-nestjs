import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Jest runs `globalSetup` and `globalTeardown` in the same process, so the
 * started container is handed between them on `globalThis`.
 *
 * A module-level variable would not survive: the two files are loaded as
 * separate module registries and each would get its own copy, so teardown would
 * see `undefined` and leave the container running until Ryuk reaped it.
 */
interface ContainerHolder {
  __EVENT_API_PG_CONTAINER__?: StartedPostgreSqlContainer;
}

const holder = globalThis as unknown as ContainerHolder;

export function rememberContainer(container: StartedPostgreSqlContainer): void {
  holder.__EVENT_API_PG_CONTAINER__ = container;
}

export function forgetContainer(): StartedPostgreSqlContainer | undefined {
  const container = holder.__EVENT_API_PG_CONTAINER__;
  delete holder.__EVENT_API_PG_CONTAINER__;
  return container;
}

/** The image the integration tier runs against: the same one Compose runs. */
export const POSTGRES_IMAGE = 'postgres:18-alpine';
