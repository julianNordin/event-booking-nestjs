# syntax=docker/dockerfile:1

# --------------------------------------------------- production dependencies ----
# Built separately so the runtime image can copy a finished tree rather than
# install into itself: the install needs to run as root and write into
# node_modules, while the process that ships must not be able to do either.
FROM node:24-alpine AS prod-deps

WORKDIR /app

# The schema and the Prisma config are copied before `npm ci` because this
# project's postinstall is `prisma generate`, which reads both. There is no
# database in a build stage and none is needed: prisma.config.ts takes the url
# from process.env.DATABASE_URL rather than prisma/config's `env()` helper,
# which throws when the variable is absent. That choice exists for this line.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma

# Install scripts run here on purpose, and the image is broken without them:
# @prisma/engines fetches the schema engine that `migrate deploy` executes, and
# with --ignore-scripts the CLI instead tries to download it at container start,
# as a non-root user, into a tree it cannot write to. That failure appears only
# when the container runs, never when it is built.
RUN npm ci --omit=dev && npm cache clean --force

# --------------------------------------------------------------------- build ----
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ------------------------------------------------------------------- runtime ----
FROM node:24-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# `migrate deploy` replays the migration history verbatim, so the SQL itself has
# to be in the image — the hand-written partial index, functional index and two
# CHECK constraints exist only in these files. prisma.config.ts is how the CLI
# finds them and the connection string.
COPY prisma ./prisma
COPY prisma.config.ts ./

# Nothing in the image writes to its own tree, so it stays owned by root and the
# process runs as a user that cannot modify the code it is executing.
USER node

EXPOSE 3000

# Uses the endpoint the service already publishes, so the container's idea of
# healthy is the same as a load balancer's: 200 only while the database is
# actually answering. wget is busybox's, already in the image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:3000/health || exit 1

# `exec` is load-bearing. Without it the shell stays PID 1, SIGTERM is delivered
# to the shell and not to node, and enableShutdownHooks() never runs — so the
# connection pool is killed rather than closed, on every deploy and restart.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/main"]
