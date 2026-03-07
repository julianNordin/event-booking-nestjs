import type { Config } from 'jest';

// tsconfig.test.json exists solely so ts-jest emits CommonJS: Prisma's generated
// client loads its WASM query compiler through dynamic import(), which Jest's
// CommonJS VM cannot execute. See the comments in that file.
const transform: Config['transform'] = {
  '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
};

/**
 * Two tiers, mirroring a Surefire/Failsafe split.
 *
 * `unit` is everything that can be settled without a database: the pure
 * registration rules, the status state machine, and services with PrismaService
 * replaced by a mock. It runs anywhere, including a machine with no Docker.
 *
 * `int` is every claim about SQL — constraints, isolation levels, locking,
 * query counts. Those are not testable against a mock by definition, so this
 * tier gets a real PostgreSQL from Testcontainers and pays the start-up cost
 * once per run.
 */
const config: Config = {
  projects: [
    {
      displayName: 'unit',
      rootDir: '.',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      transform,
      // Nothing here boots Nest, so nothing else pulls reflect-metadata in and
      // class-validator fails with "Reflect.getMetadata is not a function".
      setupFiles: ['reflect-metadata'],
    },
    {
      displayName: 'int',
      rootDir: '.',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/**/*.int-spec.ts'],
      transform,
      setupFiles: ['reflect-metadata', '<rootDir>/test/support/setup-webcrypto.ts'],
      globalSetup: '<rootDir>/test/support/global-setup.ts',
      globalTeardown: '<rootDir>/test/support/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/test/support/setup-int.ts'],
      // Starting a container is slow; nothing else here is. Most of the budget
      // for this tier is spent before the first assertion runs.
      testTimeout: 30_000,
    },
  ],

  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**', '!src/**/*.spec.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
};

export default config;
