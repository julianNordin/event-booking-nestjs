import { ConfigType, registerAs } from '@nestjs/config';

import { NodeEnv, validateEnv } from './env.validation';

export const APP_CONFIG_KEY = 'app';

/**
 * The URL prefix every route in this service sits under. Kept here rather than
 * inlined in `main.ts` so that the end-to-end tier, which bootstraps the
 * application the same way, cannot drift from it.
 */
export const GLOBAL_PREFIX = 'api/v1';

export const appConfig = registerAs(APP_CONFIG_KEY, () => {
  const env = validateEnv(process.env);

  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === NodeEnv.Production,
    port: env.PORT,
    globalPrefix: GLOBAL_PREFIX,
  };
});

export type AppConfig = ConfigType<typeof appConfig>;
