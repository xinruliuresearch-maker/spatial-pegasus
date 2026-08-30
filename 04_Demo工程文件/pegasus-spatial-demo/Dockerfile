# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Pegasus Spatial production image — Next.js 16 standalone output.
# Three stages: deps → builder → runner. Final image is ~250-300MB.
#
# Base: node:20-slim (Debian) chosen over alpine because `sharp` prebuilt
# binaries are linux-glibc; alpine's musl needs extra `libc6-compat` work.
# ---------------------------------------------------------------------------

# =============================================================================
# Stage 1 · deps — install npm dependencies in a clean layer that only changes
# when package.json / package-lock.json change.
# =============================================================================
FROM node:20-slim AS deps
WORKDIR /app

ENV NPM_CONFIG_LOGLEVEL=warn

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

# =============================================================================
# Stage 2 · builder — compile the Next.js standalone bundle.
# =============================================================================
FROM node:20-slim AS builder
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `next.config.ts` already declares `output: 'standalone'`, so the build emits
# .next/standalone/{server.js, node_modules/...} with only runtime deps.
RUN npm run build

# =============================================================================
# Stage 3 · runner — minimal production image.
# =============================================================================
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3200

# `sharp` runtime libraries — Next.js image optimization + lib/agent/image-resizer.
# `libvips` is the heavy lifter; `tini` gives proper signal forwarding for
# graceful shutdown (instrumentation-node.ts hooks SIGTERM).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libvips \
      tini \
      curl \
 && rm -rf /var/lib/apt/lists/*

# Run as non-root for blast-radius reduction; UID 1001 == standard `node` user
# in node:20-slim, but we name it explicitly for clarity.
RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs nextjs

# Copy standalone bundle. The `.next/standalone/` directory contains a
# self-contained app (server.js + minimum node_modules + necessary code).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/config ./config

USER nextjs
EXPOSE 3200

# Health check — calls /api/health which exercises the Mongo connection.
# Container is marked unhealthy if the endpoint can't be reached.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3200/api/health || exit 1

# `tini` reaps zombies and forwards SIGTERM cleanly to node, so
# instrumentation-node.ts's graceful shutdown path runs.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
