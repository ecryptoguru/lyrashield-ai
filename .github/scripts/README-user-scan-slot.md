# Disposable user scan slot regression

From the repository root, after `pnpm install --frozen-lockfile`,
`pnpm db:generate` and the normal core export prerequisites
(`pnpm exec turbo run build --filter=@lyrashield/agent-plugin... --concurrency=2`):

```sh
node .github/scripts/run-user-scan-slot-runtime.mjs /absolute/path/to/user-scan-slot.json
```

The launcher requires a local Unix-socket Docker context and provisions fresh
PostgreSQL 16 and Redis 7 containers. It accepts no database or Redis URL.
Each run uses a UUID ownership label, a unique guarded test database and random
loopback ports. Exact container IDs, labels, images and port bindings are checked
before the Redis marker is installed. Credentials go through a private temporary
environment file or child environment; runtime SQL goes through stdin. Dedicated
Prisma and Vitest configs avoid loading the developer's `.env`.

Only the 12 nonfinancial user admission runtime cases and two fixture unit cases
run. No worker/executor or provider is started. The runtime role is restricted
and has no financial table grants. The JSON report must contain at least 12 and
two passing cases respectively, with no skips or failures. Missing reports,
missing files and skipped suites fail the command.

The required CI app checks call this launcher when `database-tests` is selected,
after export prerequisites are built. Separate fresh services are intentional:
the existing CI Redis is shared by other suites, so it is not an exclusively
owned slot fixture. Existing CI tests and required contexts are preserved.

The launcher checks zero remaining fixture users/workspaces/slots, then removes
only its exact ownership-verified containers and their anonymous volumes in
`finally`, including ordinary failures and handled SIGINT/SIGTERM. Ownership
mismatch refuses deletion and fails with the logged IDs for inspection. SIGKILL,
daemon failure or host loss can prevent cleanup; inspect those exact IDs and
labels before cleanup. Keep the raw output and optional report as local evidence.
The report defaults to a temporary file removed during cleanup when no path is
supplied. Local success does not establish Linux CI or production acceptance.
