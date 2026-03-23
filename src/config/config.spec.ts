import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AppConfig, appConfig, GLOBAL_PREFIX } from './app.config';
import { DatabaseConfig, databaseConfig } from './database.config';
import { NodeEnv, validateEnv } from './env.validation';

const DATABASE_URL = 'postgresql://events:events@localhost:5432/events_test';
const API_KEYS = 'stockholm-tech:sk_test_abc,malmo-events:sk_test_def';

async function buildConfigModule(env: NodeJS.ProcessEnv) {
  const previous = process.env;
  process.env = { ...env };

  try {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          // The repository root holds a real .env once a developer has copied
          // the example; reading it here would make the test depend on a file
          // that is deliberately not checked in.
          ignoreEnvFile: true,
          load: [appConfig, databaseConfig],
          validate: validateEnv,
        }),
      ],
    }).compile();

    return moduleRef;
  } finally {
    process.env = previous;
  }
}

describe('configuration namespaces', () => {
  it('exposes the app namespace with values coerced by the validator', async () => {
    const moduleRef = await buildConfigModule({
      NODE_ENV: 'test',
      PORT: '4000',
      DATABASE_URL,
      API_KEYS,
    });

    const app = moduleRef.get<AppConfig>(appConfig.KEY);

    expect(app.port).toBe(4000);
    expect(app.nodeEnv).toBe(NodeEnv.Test);
    expect(app.isProduction).toBe(false);
    expect(app.globalPrefix).toBe(GLOBAL_PREFIX);

    await moduleRef.close();
  });

  it('exposes the database namespace with a numeric pool size', async () => {
    const moduleRef = await buildConfigModule({
      NODE_ENV: 'test',
      DATABASE_URL,
      API_KEYS,
      DATABASE_POOL_MAX: '25',
    });

    const database = moduleRef.get<DatabaseConfig>(databaseConfig.KEY);

    expect(database.url).toBe(DATABASE_URL);
    expect(database.poolMax).toBe(25);

    await moduleRef.close();
  });

  it('applies the validator defaults inside the namespaces, not just at the hook', async () => {
    // The `validate` hook and the `registerAs` factories are two separate reads
    // of the environment. This is the assertion that they agree: a default that
    // only the hook knows about would leave the namespace holding undefined.
    const moduleRef = await buildConfigModule({ DATABASE_URL, API_KEYS });

    const app = moduleRef.get<AppConfig>(appConfig.KEY);
    const database = moduleRef.get<DatabaseConfig>(databaseConfig.KEY);

    expect(app.port).toBe(3000);
    expect(app.nodeEnv).toBe(NodeEnv.Development);
    expect(database.poolMax).toBe(10);

    await moduleRef.close();
  });

  it('resolves the same values through ConfigService by dotted path', async () => {
    const moduleRef = await buildConfigModule({ NODE_ENV: 'test', DATABASE_URL, API_KEYS });

    const config = moduleRef.get(ConfigService);

    expect(config.get<number>('app.port')).toBe(3000);
    expect(config.getOrThrow<string>('database.url')).toBe(DATABASE_URL);

    await moduleRef.close();
  });

  it('refuses to build the module when the environment is broken', async () => {
    // The whole point of the validator: this must be a boot failure, not a
    // module that comes up holding undefined and fails on first use.
    await expect(buildConfigModule({ NODE_ENV: 'test' })).rejects.toThrow(/DATABASE_URL/);
  });

  it('refuses to build the module without knowing who may write', async () => {
    // Fail-closed as a boot condition. A service that starts without an
    // API_KEYS setting either rejects everybody or accepts everybody, and it is
    // reliably the second one.
    await expect(buildConfigModule({ NODE_ENV: 'test', DATABASE_URL })).rejects.toThrow(/API_KEYS/);
  });
});
