// Prisma 7 no longer reads .env by itself — the CLI stopped loading dotenv, and
// nothing here would see DATABASE_URL without this line. It must stay first:
// the datasource below reads process.env while this module is evaluating.
import 'dotenv/config';

import path from 'node:path';

import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),

  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'ts-node prisma/seed.ts',
  },

  datasource: {
    // Deliberately not prisma/config's `env()` helper, which throws when the
    // variable is absent. `prisma generate` connects to nothing, and it runs in
    // two places where no database exists and none is needed: `npm ci`'s
    // postinstall in CI, and the Docker build stage. Commands that do need a
    // connection report the missing url themselves.
    url: process.env.DATABASE_URL,
  },
});
