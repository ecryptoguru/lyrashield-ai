# ─── Stage 1: Install deps ─────────────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/auth/package.json ./packages/auth/
COPY packages/config/package.json ./packages/config/
COPY packages/db/package.json ./packages/db/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/logger/package.json ./packages/logger/
COPY packages/types/package.json ./packages/types/
COPY packages/ui/package.json ./packages/ui/
COPY apps/worker/package.json ./apps/worker/
COPY apps/agent/package.json ./apps/agent/

RUN pnpm install --frozen-lockfile

# ─── Stage 2: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate

WORKDIR /app

COPY --from=deps /app/ .

COPY . .

# Prisma config needs env vars to load at build time
ARG DATABASE_URL="postgresql://lyrashield:lyrashield@localhost:5432/lyrashield?schema=public"
ARG BETTER_AUTH_SECRET="build-placeholder-not-used-at-runtime"
ARG BETTER_AUTH_URL="http://localhost:3000"
ARG NEXT_PUBLIC_APP_URL="http://localhost:3000"

ENV DATABASE_URL=$DATABASE_URL
ENV BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
ENV BETTER_AUTH_URL=$BETTER_AUTH_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

RUN pnpm db:generate
RUN pnpm build

# ─── Stage 3: Runner ───────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy only the standalone server output + static assets
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

# Copy prisma schema + migrations for runtime
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/packages/db/package.json ./packages/db/package.json

# NOTE: The worker runs from the builder stage (see docker-compose.yml worker service)
# because workspace packages export TypeScript source (main: "./src/index.ts")
# which requires tsx at runtime. A dedicated slim worker stage will be added
# once shared packages are compiled to JS dist output.

EXPOSE 3000

WORKDIR /app/apps/web

CMD ["node", "server.js"]

# ─── Stage 4: Worker + local engine CLI ──────────────────────────────────────
# The `engine` named build context is supplied only by the worker service in
# docker-compose.yml, so web/migration builds remain independent of the sibling
# engine repository.
FROM builder AS worker

RUN apk add --no-cache python3 py3-pip

COPY --from=engine . /opt/lyrashield-engine

RUN python3 -m venv /opt/uv-bootstrap && \
    /opt/uv-bootstrap/bin/pip install --no-cache-dir uv==0.11.28 && \
    UV_PROJECT_ENVIRONMENT=/opt/lyrashield-venv \
      /opt/uv-bootstrap/bin/uv sync \
        --project /opt/lyrashield-engine \
        --frozen \
        --no-dev && \
    /opt/lyrashield-venv/bin/lyrashield --version

ENV PATH="/opt/lyrashield-venv/bin:$PATH"

WORKDIR /app
CMD ["pnpm", "--filter", "@lyrashield/worker", "exec", "tsx", "src/index.ts"]
