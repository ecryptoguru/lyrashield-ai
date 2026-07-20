# Production worker runtime

These files define the dedicated production worker boundary used by the invite-only beta. The worker image and sandbox image must both be immutable digests. Secrets are retrieved at service start from Azure Key Vault by the VM's system-assigned managed identity and are written only to a root-readable runtime file.

The worker container joins two Docker networks:

- `bridge` supplies deny-by-default outbound connectivity enforced in `DOCKER-USER`;
- `lyrashield-sandbox` is an internal Docker network used only for worker-to-sandbox control traffic.

Sandbox containers join only the internal network and therefore have no default external route. The egress policy permits DNS-only access to Azure's virtual resolver and resolves and permits only Postgres, Redis, Azure AI, R2, GitHub, OSV, CISA KEV, and FIRST EPSS endpoints. Metadata, private, loopback, benchmark, and multicast ranges are rejected before the final deny. A timer refreshes approved DNS answers every five minutes; a failed refresh leaves the last complete policy in place.

## Install

Copy the three scripts to `/usr/local/libexec/`, the units to `/etc/systemd/system/`, and make the scripts root-executable. Create `/etc/lyrashield/worker-runtime.conf` with mode `0600`:

```sh
LYRASHIELD_WORKER_IMAGE=lyrashieldprod.azurecr.io/worker@sha256:<approved-worker-digest>
LYRASHIELD_SANDBOX_IMAGE=ghcr.io/usestrix/strix-sandbox@sha256:<approved-sandbox-digest>
LYRASHIELD_SANDBOX_NETWORK=lyrashield-sandbox
```

Then reload systemd and enable the policy refresh and worker:

```sh
systemctl daemon-reload
systemctl enable --now lyrashield-worker-egress-refresh.timer
systemctl enable --now lyrashield-worker.service
```

Do not place secrets in the runtime configuration. `refresh-secrets.sh` owns the exact Key Vault-to-environment mapping and fails closed when a required secret is absent or empty.

## Verification

Before enabling scan admission:

1. Verify both configured images contain `@sha256:` and the worker container uses the expected digests.
2. Verify an allowed HTTPS endpoint, PostgreSQL, Redis, and R2 are reachable from a disposable container on `bridge`.
3. Verify a non-allowlisted public endpoint, `169.254.169.254`, and RFC1918 destinations are blocked from that same network.
4. Verify a disposable container on `lyrashield-sandbox` cannot reach a public IP.
5. Confirm the worker becomes healthy, `/api/ready/scans` becomes `200`, and the registry score advances after 45 seconds.
6. Stop the service gracefully and confirm `/api/ready/scans` returns `503`; restart it and confirm readiness recovers without replaying work.

This topology is the beta's bounded allowlist, not a general-purpose untrusted-target scanner. Expand endpoint scope only through a reviewed change and a repeated negative egress test.
