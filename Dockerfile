# syntax=docker/dockerfile:1
#
# The automations image, modelled on gpo/gpo-monolith's apps/tax-receipts
# Dockerfile. Build from the repo root:
#
#   docker build --target job   -t qomon-automations-job .
#   docker build --target tools -t qomon-automations-tools .
#
# Targets:
#   job    the job runner (`node dist/cli.js <command>`). Production deps only.
#   tools  the full workspace: runs `prisma migrate deploy` (the default
#          command) before each deploy.
#
# docs/household-match/runbook.md has the environment and the droplet setup.
# Docker builds are verified in CI or on a laptop, never in a cloud session.

ARG NODE_VERSION=22.13.1

FROM node:${NODE_VERSION}-bookworm-slim AS base
# Prisma's query engine links against OpenSSL
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# pinned to package.json "packageManager"; npm rather than corepack avoids
# corepack's signing-key checks on older Node images
RUN npm install -g pnpm@9.15.9
ENV PNPM_HOME=/pnpm \
  TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo

# Workspace manifests only, so the install layer is cached until a manifest
# or the lockfile changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.base.json ./
COPY apps/automations/package.json apps/automations/
COPY packages/qomon-client/package.json packages/qomon-client/
COPY packages/address-match-core/package.json packages/address-match-core/

FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY packages packages
COPY apps/automations apps/automations
RUN pnpm turbo run build --filter=@trellis/automations

FROM build AS tools
WORKDIR /repo/apps/automations
ENV NODE_ENV=production
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

FROM manifests AS job
ENV NODE_ENV=production
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod --store-dir /pnpm/store \
    --filter @trellis/automations...
COPY --from=build /repo/packages/qomon-client/dist packages/qomon-client/dist
COPY --from=build /repo/packages/address-match-core/dist packages/address-match-core/dist
# dist/ includes the generated Prisma client and its linux query engine
COPY --from=build /repo/apps/automations/dist apps/automations/dist
USER node
WORKDIR /repo/apps/automations
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
