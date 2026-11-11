# Provider gateway

`apps/provider-gateway` is a prototype for a separate model-provider credential boundary. Its
grants carry attempt, scan, workspace, operation, authority epoch/revision, provider, expiry and
reservation fields. The existing production worker has not yet been migrated to this boundary.

The gateway records a canonical request identity — exact method, path, query string, forwarded
content negotiation headers and body hash — before contacting the provider. A repeated request id
returns the recorded identity or its status; it never repeats the provider request, and a reused
id with any drift in that identity is an idempotency conflict.
The journal records the request, response hash and any ambiguous outcome. The response-derived
identity is not an authoritative provider-usage or settlement receipt. Request-count and caller-
supplied reservations do not establish a trustworthy cost ceiling: approved models, bounded request
shapes and server-owned pricing must be enforced before production use. Expired or revoked grants
fail closed.

Revocation is recorded without waiting for in-flight provider calls and triggers a local abort.
The provider outcome remains `UNKNOWN` when an abort or response is ambiguous. Physical teardown
can proceed concurrently, while the supervisor retains its settlement hold.

## Closed default

`LYRASHIELD_RUNTIME_ADMISSION` defaults to `closed`, so grants and provider calls are rejected.
Synthetic tests use an explicit open admission and local or mocked upstreams; they make no paid
provider calls. The service entrypoint rejects `open` until the broker and independent-journal
boundary have been qualified.

Provider routing is configured with `LYRASHIELD_PROVIDER_ROUTES_JSON`. Each entry declares a
fixed provider id, HTTPS base URL, credential environment variable, authentication mode and
allowlisted path prefixes. The credential remains in the gateway process and is injected only
for the upstream request. The service binds to `127.0.0.1:8791` by default.

Required configuration:

- `LYRASHIELD_PROVIDER_GATEWAY_JOURNAL_PATH`
- `LYRASHIELD_PROVIDER_GATEWAY_SIGNING_SECRET` (at least 32 bytes)
- `LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN` (at least 32 bytes)
- `LYRASHIELD_PROVIDER_ROUTES_JSON`
- the provider credential variables named by that route configuration

The prototype does not change production secrets or deployment routing. The broker must authorize
the exact grant and approved request policy; independent settlement, credential isolation and
qualification evidence are required before runtime admission opens.
