# Reproducible, multi-stage build. The same image serves the hosted service and
# self-host (differentiated only by config / env).
# Base image pinned by digest for reproducible builds (tag: node:22-alpine).
FROM node:22-alpine@sha256:9385cd9f3001dfc3431e8ead12c43e9e1f87cc1b9b5c6cfd0f73865d405b27c4 AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- Dependencies (cached on lockfile) ---
# NOTE: do not mount the pnpm store as a build cache. pnpm links node_modules
# into the store; a cache mount is not part of the image layer, so a later stage
# (build / runtime) would find node_modules linking into a store that no longer
# exists (e.g. `tsc` not found). Keeping the store in the layer makes
# node_modules self-contained across stages.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY core/package.json core/package.json
COPY bot/package.json bot/package.json
RUN pnpm install --frozen-lockfile

# --- Build ---
FROM deps AS build
COPY . .
RUN pnpm run build

# --- Production deps only ---
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY core/package.json core/package.json
COPY bot/package.json bot/package.json
RUN pnpm install --frozen-lockfile --prod

# --- Runtime ---
FROM base AS runtime
ENV NODE_ENV=production
# Build/version stamps surfaced on /health and /diagnostics. Passed at build
# time (e.g. --build-arg GIT_COMMIT="$(git rev-parse HEAD)"); default to dev so
# self-host `docker compose up` still builds without extra flags.
ARG GIT_COMMIT=dev
ARG APP_VERSION=0.1.0
ENV GIT_COMMIT=$GIT_COMMIT
ENV APP_VERSION=$APP_VERSION
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/core/node_modules ./core/node_modules
COPY --from=prod-deps /app/bot/node_modules ./bot/node_modules
COPY --from=build /app/core/dist ./core/dist
COPY --from=build /app/core/package.json ./core/package.json
COPY --from=build /app/core/drizzle ./core/drizzle
COPY --from=build /app/bot/dist ./bot/dist
COPY --from=build /app/bot/package.json ./bot/package.json
COPY package.json pnpm-workspace.yaml ./

EXPOSE 8080
# Migrations run automatically on boot (see bot/src/index.ts).
CMD ["node", "bot/dist/index.js"]
