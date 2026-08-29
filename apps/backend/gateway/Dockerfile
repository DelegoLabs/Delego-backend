# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @delegolabs/gateway (Issue #92).
#
# Stage 1 (deps) installs the full pnpm workspace so internal
# @delegolabs/* packages resolve correctly, then uses `pnpm deploy` to
# prune the result down to just this service + its actual dependency
# closure (workspace deps included as real files, not symlinks).
# Stage 2 (runtime) copies only that pruned output onto a slim,
# non-root Node runtime — no pnpm, no source of sibling services, no
# devDependencies.

FROM node:20-alpine AS deps
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/types/package.json packages/types/package.json
COPY packages/utils/package.json packages/utils/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY apps/backend/gateway/package.json apps/backend/gateway/package.json

# Fetch-only install first (cacheable across builds regardless of source
# changes), then a full install once the lockfile-driven store is warm.
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @delegolabs/gateway... build
RUN pnpm --filter @delegolabs/gateway deploy --prod /out/gateway

FROM node:20-alpine AS runtime
RUN addgroup -S delego && adduser -S delego -G delego
WORKDIR /app
COPY --from=deps --chown=delego:delego /out/gateway ./

USER delego
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
