# Production worker runtime

These files define the dedicated production worker boundary used by the open-registration beta. The worker image and sandbox image must both be immutable digests. Secrets are retrieved at every service start from Azure Key Vault by the VM's system-assigned managed identity and are written only to a root-readable runtime file. Worker startup also reapplies the egress policy after refreshing those endpoints.

The worker container joins two Docker networks:

- `bridge` supplies deny-by-default outbound connectivity enforced in `DOCKER-USER`;
- `lyrashield-sandbox` is an internal Docker network used only for worker-to-sandbox control traffic.

Sandbox containers join only the internal network and therefore have no default external route. The egress policy permits DNS-only access to Azure's virtual resolver and resolves and permits only Postgres, Redis, Azure AI, R2, the authenticated URL-scan egress proxy, GitHub, OSV, FIRST EPSS, and `api.parallel.ai` (Parallel Search) endpoints. CISA KEV read-only GETs use the authenticated proxy instead of a direct pin. BullMQ uses the managed Upstash TLS TCP endpoint via `REDIS_URL`; `UPSTASH_REDIS_REST_URL` remains the HTTPS interface for distributed rate limiting and is never a BullMQ connection string. Worker startup stores the complete approved IPv4 answer set and injects it into the container's hosts file, closing the resolver-to-connect race for CDN and anycast endpoints. Metadata, private, loopback, benchmark, and multicast ranges are rejected before the final deny. Every five minutes the timer resolves a complete fresh pin set. A changed set creates a random local drain challenge; the worker pauses new scan claims, waits for current jobs, and acknowledges the same challenge before the host applies new-only rules, replaces the pin file, and schedules the planned restart. Missing/late acknowledgement keeps the validated old/new union and old pin file. Restart-scheduling failure restores that union and old file before cancelling the drain so the worker can resume. Retained tuples must match a current reviewed host/port pair or the staged legacy `www.cisa.gov:443` pair.

## Worker image contract

The production worker image must run from its own `worker` stage on the digest-pinned Node 24 base. The container entrypoint is the vendored TypeScript runner bundled with the workspace, currently `./apps/worker/node_modules/.bin/tsx apps/worker/src/index.ts`. Do not rely on Corepack or `pnpm install` at container startup; images run as the non-root `lyrashield` user without a TTY.

## Install

Copy the three scripts to `/usr/local/libexec/`, the units to `/etc/systemd/system/`, and make the scripts root-executable. Create `/etc/lyrashield/worker-runtime.conf` with mode `0600`:

```sh
LYRASHIELD_WORKER_IMAGE=ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:<approved-worker-digest>
LYRASHIELD_SANDBOX_IMAGE=ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:<approved-sandbox-digest>
LYRASHIELD_SANDBOX_NETWORK=lyrashield-sandbox
# Required when either image is hosted on ghcr.io. GHCR_TOKEN is pulled from Key Vault by refresh-secrets.sh.
GHCR_USERNAME=<github-username-or-bot>
```

`/etc/lyrashield/worker.env` supplies the remaining runtime variables. Defaults in `run-worker.sh` set `NODE_ENV=production`, the exact two-account platform-admin allowlist, `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0`, and `LYRASHIELD_WORKER_CONCURRENCY=1`; override email verification or concurrency there when needed. The platform-admin allowlist is code-owned and must not drift.

## Promote a verified worker release

Digest pinning prevents silent updates; it does not freeze the worker. After the application repository's main deployment verifies a SHA-only worker image, its exact digest, and its OCI labels, update only `LYRASHIELD_WORKER_IMAGE` in `/etc/lyrashield/worker-runtime.conf` to that `@sha256:` reference. Retain the previous configuration as the rollback record and restart `lyrashield-worker.service`.

`run-worker.sh` derives the worker execution provenance entirely from the immutable image: `LYRASHIELD_PRODUCT_REVISION` from the `org.opencontainers.image.revision` label, `LYRASHIELD_ENGINE_REVISION` from the `io.lyrashield.engine.revision` label, and `LYRASHIELD_WORKER_IMAGE_DIGEST` from the pinned reference itself. All three are validated as exact 40-hex/`sha256:<64 hex>` values before the container is created, and the production worker fails closed before readiness if any is missing. Never set these three variables by hand in `worker.env` — the launcher owns them.

After restarting, reconcile the configured and running image references, the `org.opencontainers.image.revision` and `io.lyrashield.engine.revision` labels, the three provenance environment values inside the running container, Docker health, and `/api/ready/scans`. Never promote `latest`, another mutable tag, an unverified digest, or an engine branch. To roll back, restore the prior digest reference and repeat the same checks.

For Azure AI Foundry, retrieve `LYRASHIELD_LUNA_LLM`, `LYRASHIELD_TERRA_LLM`, `AZURE_AI_API_KEY`, `AZURE_AI_API_BASE`, and `AZURE_API_VERSION` from Key Vault as one coherent deployment route. `LYRASHIELD_LLM` is the explicit fallback only. Do not set `LYRASHIELD_PROGRAMMATIC_TOOL_CALLING` for the configured endpoint: it rejects that Responses tool type, so direct JSON function tools are the supported production route. Enable the flag only after the engine provider-contract gate passes for the exact deployment.

Then reload systemd and enable the policy refresh and worker:

```sh
systemctl daemon-reload
systemctl enable --now lyrashield-worker-egress-refresh.timer
systemctl enable --now lyrashield-worker.service
```

Do not place secrets in the runtime configuration. `refresh-secrets.sh` owns the exact Key Vault-to-environment mapping and fails closed when a required secret is absent or empty. The Key Vault must contain both `worker-database-url` (the RLS-restricted runtime role) and `worker-database-system-url` (the privileged ownership-check role), the BullMQ TLS endpoint as `worker-redis-url`, and both authenticated egress-proxy secrets. `run-worker.sh` initializes the persistent runs volume through a networkless one-shot container, then starts the application as the image's non-root user.

Keep `LYRASHIELD_STALE_RESOURCE_REAPER_ENABLED=1`. The defaults run every 15 minutes and consider only resources at least 24 hours old. The reaper selects containers by the `strix-run-id` label and directories under the fixed checkout/run roots, skips running containers and scans in `QUEUED`, `PREFLIGHT`, `RUNNING`, or `VERIFYING`, and fails safe when scan ownership cannot be read. `REQUIRES_APPROVAL` occurs before worker execution and owns no checkout, run directory, or sandbox container. Do not replace the reaper with `docker system prune` or broad filesystem deletion.

## Verification

Before enabling scan admission:

1. Verify both configured images contain `@sha256:` and the worker container uses the expected digests.
2. Verify an allowed HTTPS endpoint, PostgreSQL, Redis, and R2 are reachable from a disposable container on `bridge`.
3. Verify a non-allowlisted public endpoint, `169.254.169.254`, and RFC1918 destinations are blocked from that same network.
4. Verify a disposable container on `lyrashield-sandbox` cannot reach a public IP.
5. Confirm the worker becomes healthy, `/api/ready/scans` becomes `200`, and the registry score advances after 45 seconds.
6. Stop the service gracefully and confirm `/api/ready/scans` returns `503`; restart it and confirm readiness recovers without replaying work.
7. Run the engine's bounded provider-contract baseline against the deployed Azure route. Record its capability result with the deployment revision; run the programmatic-tool gate only when evaluating that optional feature.
8. Confirm the worker image revision label matches the reviewed app commit and its engine-revision label matches the immutable engine checkout used by CI.
9. Run the stale-resource reaper acceptance case: an old stopped owned fixture is removed, an active/running fixture is retained, and the result is visible in worker logs.

Inspect `/run/lyrashield-egress-hosts` only as root when diagnosing endpoint drift. Every line must contain an approved hostname, one public IPv4 address, and its TCP port. Never hand-edit the file or add an unreviewed destination.

Run `sh ops/worker/refresh-egress.test.sh` on Linux to verify DNS rotation, atomic pin replacement, active-scan restart deferral, and the idle pending restart.

## URL-scan egress proxy

`LYRASHIELD_EGRESS_PROXY_URL` and `LYRASHIELD_EGRESS_PROXY_SECRET` are added to the worker environment by `refresh-secrets.sh`. The worker's URL scanner routes each hop of the scan through this authenticated proxy instead of connecting directly to arbitrary public targets. The proxy performs the same DNS-resolved, IP-pinned, SSRF-safe fetch as the worker, then returns the raw response so the worker's redirect and byte bounds remain in effect. The proxy endpoint is added to the allowlist in `refresh-egress.sh` and is updated on every timer refresh. Add it to the production environment, rotate its secret in Key Vault (`worker-egress-proxy-url` and `worker-egress-proxy-secret`), and promote a new worker image digest only after a negative egress test confirms the proxy is the only path for arbitrary public fetches.

Only CISA KEV enrichment joins URL scans on this read-only proxy path; if the authenticated proxy is unavailable, CISA enrichment is skipped rather than attempted directly. FIRST EPSS stays direct because its batched request uses a query string that this route intentionally rejects; OSV stays direct because it requires a JSON POST body. GitHub smart HTTP/API and Parallel's controlled-engine POST stay direct. PostgreSQL, Redis, Azure AI, object storage, and the proxy endpoint itself remain direct because they use incompatible protocols or authenticated service-specific requests. Do not add request bodies, arbitrary methods, or caller-supplied authorization headers to the generic proxy.

Roll out in this order: first promote the worker image that proxies CISA and verify CISA enrichment plus existing proxy negative tests while the old CISA pin still exists; then deploy the refreshed host script and verify that the direct CISA pin is removed. Reversing the order can strand the old worker without a CISA route.

This topology is the beta's bounded allowlist, not a general-purpose untrusted-target scanner. Expand endpoint scope only through a reviewed change and a repeated negative egress test.

## Web Search (Parallel Search)

Web search is an optional engine capability that calls `https://api.parallel.ai/v1/search`. When enabled, `refresh-secrets.sh` pulls the `worker-web-search-api-key` secret into `LYRASHIELD_WEB_SEARCH_API_KEY` and `refresh-egress.sh` adds `api.parallel.ai:443` to the worker's pinned allowlist. `run-worker.sh` enables the feature by default only when `LYRASHIELD_WEB_SEARCH_API_KEY` is present in the worker env file; set `LYRASHIELD_WEB_SEARCH_ENABLED=1` or `0` in `worker-runtime.conf` to override.

Non-secret tuning variables (`LYRASHIELD_WEB_SEARCH_MODE`, `LYRASHIELD_WEB_SEARCH_MAX_RESULTS`, `LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL`, `LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN`, `LYRASHIELD_WEB_SEARCH_BUDGET_USD`) may be added to `/etc/lyrashield/worker-runtime.conf` and are passed to the worker container by `run-worker.sh`. The engine redacts target hosts, secrets, and PII before sending a query and records web-search cost under a separate per-scan budget.
