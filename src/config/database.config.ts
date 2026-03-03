import { ConfigType, registerAs } from '@nestjs/config';

import { validateEnv } from './env.validation';

export const DATABASE_CONFIG_KEY = 'database';

export const databaseConfig = registerAs(DATABASE_CONFIG_KEY, () => {
  const env = validateEnv(process.env);

  return {
    url: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
  };
});

export type DatabaseConfig = ConfigType<typeof databaseConfig>;
