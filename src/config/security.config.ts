import { ConfigType, registerAs } from '@nestjs/config';

import { validateEnv } from './env.validation';

export const SECURITY_CONFIG_KEY = 'security';

/** The header a caller presents their key in. */
export const API_KEY_HEADER = 'x-api-key';

export interface OrganiserIdentity {
  /** The organiser this key belongs to. Appears in audit lines, never in a response. */
  name: string;
}

/**
 * Parses `name:key,name:key` into a lookup from key to organiser.
 *
 * Keyed by the secret rather than by the name, because that is the direction
 * every request goes: a caller presents a key and the guard has to decide, in
 * constant time, whether it belongs to anybody.
 */
export function parseApiKeys(raw: string): Map<string, OrganiserIdentity> {
  const organisers = new Map<string, OrganiserIdentity>();

  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();

    if (trimmed === '') {
      continue;
    }

    const separator = trimmed.indexOf(':');
    const name = trimmed.slice(0, separator).trim();
    const key = trimmed.slice(separator + 1).trim();

    organisers.set(key, { name });
  }

  return organisers;
}

export const securityConfig = registerAs(SECURITY_CONFIG_KEY, () => {
  const env = validateEnv(process.env);

  return {
    organisersByKey: parseApiKeys(env.API_KEYS),
    /** Requests per window on the public write endpoints. */
    throttleLimit: env.THROTTLE_LIMIT,
    /** The window, in milliseconds. */
    throttleTtlMs: env.THROTTLE_TTL_MS,
  };
});

export type SecurityConfig = ConfigType<typeof securityConfig>;
