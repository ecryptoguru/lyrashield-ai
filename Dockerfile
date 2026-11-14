# ─── Stage 1: Install deps ─────────────────────────────────────────────────────
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS deps
RUN corepack enable && corepack prepare pnpm@12.2.0 --activate
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/marketing/package.json ./apps/marketing/
COPY apps/marketing-motion/package.json ./apps/marketing-motion/
COPY packages/agent-registry/package.json ./packages/agent-registry/
COPY packages/agent-rules/package.json ./packages/agent-rules/
COPY packages/auth/package.json ./packages/auth/
COPY packages/cli/package.json ./packages/cli/
COPY packages/cli-alias/package.json ./packages/cli-alias/
COPY packages/config/package.json ./packages/config/
COPY packages/db/package.json ./packages/db/
COPY packages/runtime-control/package.json ./packages/runtime-control/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/logger/package.json ./packages/logger/
COPY packages/types/package.json ./packages/types/
COPY packages/ui/package.json ./packages/ui/
COPY packages/score/package.json ./packages/score/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/security/package.json ./packages/security/
COPY packages/egress-proxy/package.json ./packages/egress-proxy/
COPY apps/worker/package.json ./apps/worker/

RUN pnpm install --frozen-lockfile

# ─── Stage 2: Build ────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS workspace-builder
RUN corepack enable && corepack prepare pnpm@12.2.0 --activate

WORKDIR /app

COPY --from=deps /app/ .

COPY . .

# Prisma config needs env vars to load at build time
ARG BUILD_DATABASE_URL="postgresql://build@db.example.invalid:5432/lyrashield?schema=public"
ARG BUILD_APP_URL="https://app.example.invalid"
ARG BUILD_PUBLIC_APP_URL="https://app.example.invalid"
ARG BUILD_PUBLIC_MARKETING_URL="https://lyrashieldai.com"
ARG BUILD_TRUSTED_PROXY_IP_HEADER="x-forwarded-for"

RUN DATABASE_URL="$BUILD_DATABASE_URL" \
    BETTER_AUTH_SECRET="build-placeholder-not-used-at-runtime" \
    BETTER_AUTH_URL="$BUILD_APP_URL" \
    NEXT_PUBLIC_APP_URL="$BUILD_PUBLIC_APP_URL" \
    NEXT_PUBLIC_MARKETING_URL="$BUILD_PUBLIC_MARKETING_URL" \
    pnpm db:generate

# Materialize only the worker's production dependency closure. This keeps the
# final image independent of unrelated web, marketing, and test dependencies.
FROM workspace-builder AS worker-deps

RUN pnpm --filter @lyrashield/worker deploy --prod --legacy /worker-runtime

# Materialize each control-plane role's production closure. All three depend on
# @lyrashield/db, so `pg` resolves from the deploy root as the epoch probe expects.
FROM workspace-builder AS controller-deps

RUN pnpm --filter @lyrashield/broker deploy --prod --legacy /controller-broker && \
    pnpm --filter @lyrashield/supervisor deploy --prod --legacy /controller-supervisor && \
    pnpm --filter @lyrashield/provider-gateway deploy --prod --legacy /controller-provider-gateway

FROM workspace-builder AS web-builder

ARG BUILD_DATABASE_URL="postgresql://build@db.example.invalid:5432/lyrashield?schema=public"
ARG BUILD_APP_URL="https://app.example.invalid"
ARG BUILD_PUBLIC_APP_URL="https://app.example.invalid"
ARG BUILD_PUBLIC_MARKETING_URL="https://lyrashieldai.com"
ARG BUILD_TRUSTED_PROXY_IP_HEADER="x-forwarded-for"
ARG BUILD_LYRASHIELD_REQUIRE_EMAIL_VERIFICATION="1"
ARG BUILD_NEXT_PUBLIC_POSTHOG_KEY=""
ARG BUILD_NEXT_PUBLIC_SENTRY_DSN=""
ARG BUILD_NEXT_PUBLIC_SENTRY_RELEASE=""

RUN DATABASE_URL="$BUILD_DATABASE_URL" \
    BETTER_AUTH_SECRET="build-placeholder-not-used-at-runtime" \
    BETTER_AUTH_URL="$BUILD_APP_URL" \
    NEXT_PUBLIC_APP_URL="$BUILD_PUBLIC_APP_URL" \
    NEXT_PUBLIC_MARKETING_URL="$BUILD_PUBLIC_MARKETING_URL" \
    NEXT_PUBLIC_POSTHOG_KEY="$BUILD_NEXT_PUBLIC_POSTHOG_KEY" \
    NEXT_PUBLIC_SENTRY_DSN="$BUILD_NEXT_PUBLIC_SENTRY_DSN" \
    NEXT_PUBLIC_SENTRY_RELEASE="$BUILD_NEXT_PUBLIC_SENTRY_RELEASE" \
    TRUSTED_PROXY_IP_HEADER="$BUILD_TRUSTED_PROXY_IP_HEADER" \
    LYRASHIELD_REQUIRE_EMAIL_VERIFICATION="$BUILD_LYRASHIELD_REQUIRE_EMAIL_VERIFICATION" \
    pnpm exec turbo run build --filter=@lyrashield/web

# ─── Stage 3: Runner ───────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runner
RUN addgroup --system lyrashield && \
    adduser --system --ingroup lyrashield --home /app lyrashield

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy only the standalone server output + static assets
COPY --chown=lyrashield:lyrashield --from=web-builder /app/apps/web/.next/standalone ./
COPY --chown=lyrashield:lyrashield --from=web-builder /app/apps/web/.next/static ./apps/web/.next/static

# Copy prisma schema + migrations for runtime
COPY --chown=lyrashield:lyrashield --from=web-builder /app/packages/db/prisma ./packages/db/prisma
COPY --chown=lyrashield:lyrashield --from=web-builder /app/packages/db/package.json ./packages/db/package.json

EXPOSE 3000

WORKDIR /app/apps/web

USER lyrashield
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]

# ─── Stage 4: Dedicated egress-proxy runtime ─────────────────────────────────
FROM workspace-builder AS egress-proxy-deps

RUN pnpm --filter @lyrashield/egress-proxy build && \
    pnpm --filter @lyrashield/egress-proxy deploy --prod --legacy /egress-proxy-runtime

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS egress-proxy

RUN addgroup --system lyrashield && \
    adduser --system --ingroup lyrashield --home /app lyrashield

WORKDIR /app

ENV NODE_ENV=production

COPY --chown=lyrashield:lyrashield --from=egress-proxy-deps /egress-proxy-runtime ./
COPY --chown=lyrashield:lyrashield --from=egress-proxy-deps /app/packages/egress-proxy/dist ./dist

EXPOSE 4000

USER lyrashield
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:4000/health || exit 1
CMD ["node", "dist/index.js"]

# ─── Stage 5: Worker engine environment ──────────────────────────────────────
# The `engine` named build context is supplied only by the worker service in
# docker-compose.yml, so web/migration builds remain independent of the sibling
# engine repository.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS worker-engine

RUN apk add --no-cache python3 py3-pip build-base python3-dev git

COPY --from=engine . /opt/lyrashield-engine

RUN python3 -m venv /opt/uv-bootstrap && \
    /opt/uv-bootstrap/bin/pip install --no-cache-dir uv==0.11.28 && \
    UV_PROJECT_ENVIRONMENT=/opt/lyrashield-venv \
      /opt/uv-bootstrap/bin/uv sync \
        --project /opt/lyrashield-engine \
        --frozen \
        --no-editable \
        --no-dev && \
    /opt/lyrashield-venv/bin/lyrashield --version && \
    rm -rf /opt/uv-bootstrap

# The controller launches the existing engine CLI directly, without worker/Docker access.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS controller-engine
ARG PRODUCT_REVISION
ARG ENGINE_REVISION
LABEL org.opencontainers.image.source="https://github.com/ecryptoguru/lyrashield-ai" \
      org.opencontainers.image.revision="$PRODUCT_REVISION" \
      com.lyrashield.engine.revision="$ENGINE_REVISION"
RUN apk add --no-cache python3 git
COPY --from=worker-engine /opt/lyrashield-venv /opt/lyrashield-venv
ENV PATH="/opt/lyrashield-venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1
WORKDIR /workspace
USER 1000:1000
ENTRYPOINT []
CMD []

# ─── Stage 6: Dedicated worker runtime ───────────────────────────────────────
# Do not inherit `builder`: it contains the web production build and causes the
# worker image to be needlessly large. The worker needs only workspace runtime
# packages, its TypeScript entry point, the generated Prisma client, and the
# isolated engine virtual environment.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS worker

RUN apk add --no-cache docker-cli git python3 && \
    addgroup --system lyrashield && \
    adduser --system --ingroup lyrashield --home /app lyrashield

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PATH="/opt/lyrashield-venv/bin:$PATH"

COPY --from=worker-deps /worker-runtime ./apps/worker
COPY --from=worker-engine /opt/lyrashield-venv /opt/lyrashield-venv
COPY ops/worker/recover-worker.sh /opt/lyrashield-worker-host/recover-worker.sh
COPY ops/worker/worker-recovery-probe.mjs /opt/lyrashield-worker-host/worker-recovery-probe.mjs
COPY ops/worker/lyrashield-worker-recover.service /opt/lyrashield-worker-host/lyrashield-worker-recover.service
COPY ops/worker/cold-start-barrier.py /opt/lyrashield-worker-host/cold-start-barrier.py
COPY ops/worker/run-worker.sh /opt/lyrashield-worker-host/run-worker.sh
COPY ops/worker/worker-env.sh /opt/lyrashield-worker-host/worker-env.sh
COPY ops/worker/webhook-cutover-recovery.mjs /opt/lyrashield-worker-host/webhook-cutover-recovery.mjs
COPY ops/worker/webhook-cutover-schema.mjs /opt/lyrashield-worker-host/webhook-cutover-schema.mjs
COPY ops/worker/v26-cutover-identity.mjs /opt/lyrashield-worker-host/v26-cutover-identity.mjs
COPY ops/worker/refresh-secrets.sh /opt/lyrashield-worker-host/refresh-secrets.sh
COPY ops/worker/refresh-egress.sh /opt/lyrashield-worker-host/refresh-egress.sh
COPY ops/worker/capture-stop-provenance.sh /opt/lyrashield-worker-host/capture-stop-provenance.sh
COPY ops/worker/lyrashield-worker.service /opt/lyrashield-worker-host/lyrashield-worker.service
COPY ops/worker/lyrashield-worker-secrets.service /opt/lyrashield-worker-host/lyrashield-worker-secrets.service
COPY ops/worker/lyrashield-worker-egress.service /opt/lyrashield-worker-host/lyrashield-worker-egress.service
COPY ops/worker/lyrashield-worker-egress-refresh.service /opt/lyrashield-worker-host/lyrashield-worker-egress-refresh.service
COPY ops/worker/lyrashield-worker-egress-refresh.timer /opt/lyrashield-worker-host/lyrashield-worker-egress-refresh.timer

# Product tests are build inputs, not worker runtime assets. Named volumes are
# initialized from the image, so create and own only the runtime-write paths.
RUN find /app/apps/worker -type f \
      \( -name "*.test.ts" -o -name "*.test.tsx" \) -delete && \
    mkdir -p /app/lyrashield_runs /app/.lyrashield/evidence && \
    chown lyrashield:lyrashield /app/lyrashield_runs /app/.lyrashield/evidence

USER lyrashield
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD test -f /tmp/lyrashield-worker-ready && find /tmp/lyrashield-worker-ready -mmin -2 || exit 1
CMD ["./apps/worker/node_modules/.bin/tsx", "apps/worker/src/index.ts"]

# ─── Stage 7: Control-plane runtime (broker, supervisor, provider-gateway) ───
# One shared base, three isolated closures. The protected host binds each role's
# private socket; the epoch probe resolves `pg` through /app/packages/db/package.json.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS controller-base

ARG PRODUCT_REVISION
ARG ENGINE_REVISION
LABEL org.opencontainers.image.source="https://github.com/ecryptoguru/lyrashield-ai" \
      org.opencontainers.image.revision="$PRODUCT_REVISION" \
      com.lyrashield.engine.revision="$ENGINE_REVISION"

RUN addgroup --system lyrashield && \
    adduser --system --ingroup lyrashield --home /app lyrashield

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# The observation probe resolves `pg` from this exact path, so it must exist even
# though the app's own closure already carries it at the deploy root.
COPY --from=workspace-builder --chown=lyrashield:lyrashield /app/packages/db/package.json ./packages/db/package.json
COPY --chown=lyrashield:lyrashield ops/controller/health.mjs /opt/lyrashield-controller/health.mjs

RUN mkdir -p /run/lyrashield /opt/lyrashield-runtime && \
    chown lyrashield:lyrashield /run/lyrashield && \
    chmod 750 /run/lyrashield && chmod 755 /opt/lyrashield-runtime

USER lyrashield
CMD ["./node_modules/.bin/tsx", "src/index.ts"]

FROM controller-base AS controller

COPY --from=controller-deps --chown=lyrashield:lyrashield /controller-broker ./
# Keep the default bind path identical to the healthcheck probe below; the host
# may override it, and then must override the probe with the same path.
ENV LYRASHIELD_BROKER_SOCKET_PATH=/run/lyrashield/broker.sock
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/opt/lyrashield-controller/health.mjs", "/run/lyrashield/broker.sock"]

FROM controller-base AS supervisor

# The supervisor is the only role that drives the container executor, so the CLI
# stays out of the broker and provider-gateway images.
USER root
RUN apk add --no-cache docker-cli
USER lyrashield

COPY --from=controller-deps --chown=lyrashield:lyrashield /controller-supervisor ./
ENV LYRASHIELD_SUPERVISOR_SOCKET_PATH=/run/lyrashield/supervisor.sock
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/opt/lyrashield-controller/health.mjs", "/run/lyrashield/supervisor.sock"]

FROM controller-base AS provider-gateway

COPY --from=controller-deps --chown=lyrashield:lyrashield /controller-provider-gateway ./
ENV LYRASHIELD_PROVIDER_GATEWAY_SOCKET_PATH=/run/lyrashield/provider-gateway.sock
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/opt/lyrashield-controller/health.mjs", "/run/lyrashield/provider-gateway.sock"]
