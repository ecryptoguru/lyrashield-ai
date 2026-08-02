# Production worker runtime

These files define the dedicated production worker boundary used by the open-registration beta. The worker image and sandbox image must both be immutable digests. Secrets are retrieved at every service start from Azure Key Vault by the VM's system-assigned managed identity and are written only to a root-readable runtime file. Worker startup also reapplies the egress policy after refreshing those endpoints.

The worker container joins two Docker networks:

- `bridge` supplies deny-by-default outbound connectivity enforced in `DOCKER-USER`;
- `lyrashield-sandbox` is an internal Docker network used only for worker-to-sandbox control traffic.

Sandbox containers join only the internal network and therefore have no default external route. The egress policy permits DNS-only access to Azure's virtual resolver and resolves and permits only Postgres, Redis, Azure AI, R2, the authenticated URL-scan egress proxy, GitHub, OSV, CISA KEV, and FIRST EPSS endpoints. The Redis endpoint in the egress allowlist is the Azure VM-hosted Redis used by BullMQ via `REDIS_URL`; the Upstash Redis REST endpoint (`UPSTASH_REDIS_REST_URL`) is used only for distributed rate limiting and is a separate service. Worker startup stores the complete approved IPv4 answer set and injects it into the container's hosts file, closing the resolver-to-connect race for CDN and anycast endpoints. Metadata, private, loopback, benchmark, and multicast ranges are rejected before the final deny. A timer refreshes firewall answers every five minutes while retaining the running container's pinned set; a failed refresh leaves the last complete policy in place. Restart the worker to promote a refreshed pin set.

## Worker image contract

The production worker image must run from its own `worker` stage. The container entrypoint is expected to be the vendored TypeScript runner bundled with the workspace, for example `./apps/worker/node_modules/.bin/tsx apps/worker/src/index.ts`. Do not rely on Corepack or `pnpm install` at container startup; images run as the non-root `lyrashield` user without a TTY.

## Install

Copy the three scripts to `/usr/local/libexec/`, the units to `/etc/systemd/system/`, and make the scripts root-executable. Create `/etc/lyrashield/worker-runtime.conf` with mode `0600`:

```sh
LYRASHIELD_WORKER_IMAGE=ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:<approved-worker-digest>
LYRASHIELD_SANDBOX_IMAGE=ghcr.io/usestrix/strix-sandbox@sha256:<approved-sandbox-digest>
LYRASHIELD_SANDBOX_NETWORK=lyrashield-sandbox
# Required when either image is hosted on ghcr.io. GHCR_TOKEN is pulled from Key Vault by refresh-secrets.sh.
GHCR_USERNAME=<github-username-or-bot>
```

`/etc/lyrashield/worker.env` supplies the remaining runtime variables. Defaults in `run-worker.sh` set `NODE_ENV=production`, `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0`, and `LYRASHIELD_WORKER_CONCURRENCY=1`; override these there if the deployment requires email verification or a different concurrency.

For Azure AI Foundry, retrieve `LYRASHIELD_LUNA_LLM`, `LYRASHIELD_TERRA_LLM`, `AZURE_AI_API_KEY`, `AZURE_AI_API_BASE`, and `AZURE_API_VERSION` from Key Vault as one coherent deployment route. `LYRASHIELD_LLM` is the explicit fallback only. Do not set `LYRASHIELD_PROGRAMMATIC_TOOL_CALLING` for the configured endpoint: it rejects that Responses tool type, so direct JSON function tools are the supported production route. Enable the flag only after the engine provider-contract gate passes for the exact deployment.

Then reload systemd and enable the policy refresh and worker:

```sh
systemctl daemon-reload
systemctl enable --now lyrashield-worker-egress-refresh.timer
systemctl enable --now lyrashield-worker.service
```

Do not place secrets in the runtime configuration. `refresh-secrets.sh` owns the exact Key Vault-to-environment mapping and fails closed when a required secret is absent or empty. The Key Vault must contain both `worker-database-url` (the RLS-restricted runtime role) and `worker-database-system-url` (the privileged ownership-check role). `run-worker.sh` initializes the persistent runs volume through a networkless one-shot container, then starts the application as the image's non-root user.

## Verification

Before enabling scan admission:

1. Verify both configured images contain `@sha256:` and the worker container uses the expected digests.
2. Verify an allowed HTTPS endpoint, PostgreSQL, Redis, and R2 are reachable from a disposable container on `bridge`.
3. Verify a non-allowlisted public endpoint, `169.254.169.254`, and RFC1918 destinations are blocked from that same network.
4. Verify a disposable container on `lyrashield-sandbox` cannot reach a public IP.
5. Confirm the worker becomes healthy, `/api/ready/scans` becomes `200`, and the registry score advances after 45 seconds.
6. Stop the service gracefully and confirm `/api/ready/scans` returns `503`; restart it and confirm readiness recovers without replaying work.
7. Run the engine's bounded provider-contract baseline against the deployed Azure route. Record its capability result with the deployment revision; run the programmatic-tool gate only when evaluating that optional feature.

Inspect `/run/lyrashield-egress-hosts` only as root when diagnosing endpoint drift. Every line must contain an approved hostname, one public IPv4 address, and its TCP port. Never hand-edit the file or add an unreviewed destination.

## URL-scan egress proxy

`LYRASHIELD_EGRESS_PROXY_URL` and `LYRASHIELD_EGRESS_PROXY_SECRET` are added to the worker environment by `refresh-secrets.sh`. The worker's URL scanner routes each hop of the scan through this authenticated proxy instead of connecting directly to arbitrary public targets. The proxy performs the same DNS-resolved, IP-pinned, SSRF-safe fetch as the worker, then returns the raw response so the worker's redirect and byte bounds remain in effect. The proxy endpoint is added to the allowlist in `refresh-egress.sh` and is updated on every timer refresh. Add it to the production environment, rotate its secret in Key Vault (`worker-egress-proxy-url` and `worker-egress-proxy-secret`), and promote a new worker image digest only after a negative egress test confirms the proxy is the only path for arbitrary public fetches.

This topology is the beta's bounded allowlist, not a general-purpose untrusted-target scanner. Expand endpoint scope only through a reviewed change and a repeated negative egress test.
