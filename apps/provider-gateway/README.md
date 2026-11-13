# Provider gateway

`apps/provider-gateway` is a closed prototype for a separate model-provider credential boundary.
The existing production worker and engine have not been migrated to this boundary.

## Authorization and request policy

A configured route alone does not authorize provider access. Grant issuance and every new request
or retained-response replay require an injected trusted `authorizeGrant(request)` broker adapter.
That adapter must revalidate the persisted attempt, scan, workspace, operation, authority epoch and
revision, funding and expiry, and return its approved policy. The gateway compares that policy
with the server route policy and the immutable policy snapshot recorded at grant issuance.
No production broker adapter is installed. Missing authorization, policy drift or missing encrypted
retention fails closed. Version 2 gateway tokens bind scan, workspace, operation, authority epoch,
revision, provider, expiry and policy digest to the persisted grant.

The internal version 1 `responses-text-v1` policy approves one exact Responses API pathname and
query, explicit models and a pricing revision, integer microdollar rates, request and response byte
caps, input and output envelopes, grant request/concurrency limits, aggregate reservations, an
absolute deadline and an idle timeout. Only bounded text input with a required `max_output_tokens`
is accepted. Tools, media, attachments, previous-response IDs and other request fields are denied.
The per-call reservation uses the full approved input envelope, the requested bounded output cap
and the highest approved input/cache rate. It ignores the caller's `costReservationMicros` and
retains reservations after ambiguous outcomes; the smaller broker-grant and server aggregate cap
applies. At most eight physically unresolved provider requests are permitted across all grants
in one gateway journal. Both the global limit and the per-grant limit count durable dispatch
intents, including `UNKNOWN` requests, across local timeouts, aborts and restarts. A slot releases
only after an authenticated terminal response is durably recorded. Late network completion and
local revocation or shutdown do not establish provider stop evidence; no trusted provider-stop
adapter is installed in this prototype. Private request status reports `physicalOutstanding`.

The text byte envelope includes a conservative 1,024-token framing allowance. Its tokenizer and
provider pricing/usage semantics remain unqualified. It must not be treated as a measured token
bound or as permission to open admission. Production policy must be bound to the canonical routing,
budget and pricing authorities rather than independently authored route prices.

## Provider outcomes and replay

The gateway journals the canonical request identity before provider dispatch: method, exact path
and query, normalized forwarded content negotiation headers and exact body hash. Conflicting
reuse of a request ID fails. Unknown requests are never resubmitted.

Provider bytes are read one chunk at a time with byte, idle and deadline guards and incremental
SHA-256 hashing. The Responses adapter parses fragmented UTF-8 SSE frames, binds provider response
identity/model, and requires an affirmative completed terminal response and bounded, internally
consistent token usage. Missing/malformed usage, conflicting/duplicate terminal identities,
partial streams, HTTP errors, revocation, expiration and unacknowledged provider outcomes remain
`UNKNOWN`. Grant validity is rechecked after asynchronous authorization and journal writes,
immediately before serialized provider dispatch and each delivery effect; queued revocations block
dispatch and replay. Usage identity authenticates the request/attempt and terminal token buckets; it is
not derived from the output hash. This narrow adapter does not support other provider APIs or
usage/cache-write shapes.

Completed bytes, status and the allowlisted forwarded headers are encrypted with AES-256-GCM using
a separately configured secret and request/response identity as authenticated associated data.
The signed journal records the encrypted response and terminal usage before any completed response
is returned. An exact duplicate decrypts and verifies those retained bytes and never contacts the
provider while that service retains its acknowledged completion. A lost result acknowledgement
closes local admission. On restart, every recovered success becomes `UNKNOWN` and restores its
physical/funding hold before broker authorization. A local journal cannot distinguish a persisted
completion whose file sync or acknowledgement failed from an acknowledged completion. Independent
authenticated reconciliation is required before recovered replay, usage or hold release; no such
adapter is installed. A separate recovery uncertainty event preserves historical authenticated
usage and encrypted bytes privately without rewriting them. Unresolved restart records also receive
a durable `UNKNOWN` result. Recovery write failures keep initialization and admission closed.
Wrong encryption keys or invalid retained bytes fail replay and never cause resubmission.

A private HMAC response-identity tombstone is reconstructed from signed terminal evidence and
survives uncertainty even when usage and replay are withheld. Cross-request response-ID reuse is
rejected. The tombstone is excluded from request status and customer-accounting payloads.

The HTTP adapter now delivers SSE incrementally. Provider reads pause until each downstream
write is acknowledged and, when required, the writable stream drains. At most one 64 KiB delivery
chunk is outstanding per stream; fixed response storage bounds tiny-fragment overhead, the total
response remains capped at 4 MiB, and an individual SSE frame/fragment is capped at 256 KiB.
The server-approved idle and absolute deadlines also bound stalled downstream delivery. At most
eight downstream deliveries, including concurrent replays, can be active in one service instance.

Every HTTP provider request requires `x-lyra-scan-id` and `x-lyra-request-id`, with the scan identity
matching the signed grant and persisted request. Each header/write/end effect shares the grant
and revocation serialization fence; writes acknowledge outside that fence so stalled consumers
cannot block revocation. Revocation, expiry and disconnect abort further delivery. The HTTP adapter
destroys an already-started failed stream instead of appending an error JSON body to provider bytes.

Streamed bytes, including a provider terminal event, are provisional. HTTP 200 or transport EOF
alone is not a completed gateway or settlement receipt. Terminal usage, complete bounded provider
bytes, downstream completion and durable encrypted retention must all succeed before request
status becomes replayable. The streaming response exposes no precomputed usage/settlement header;
the private status adapter supplies the durable receipt after completion. Buffered responses keep
the existing usage-ID header. Exact retained bytes can be streamed again with backpressure without
another provider call. Failure of a replay delivery does not create new provider work or erase the
original authenticated completed receipt.

Partial/malformed streams, downstream disconnect, unacknowledged provider aborts and a crash with
only a dispatch intent remain `UNKNOWN`, retaining physical and funding reservations. A separate
signed uncertainty event preserves that hold if delivery/acknowledgement becomes uncertain around
the completion journal write; historical records are not rewritten. Retention still uses the bounded
local signed journal. Managed keys, external encrypted object retention, capacity/lifecycle and
physical isolation qualification and independent settlement remain outstanding.

## Wire-format qualification

This adapter uses raw `fetch`; the gateway installs no provider SDK and pins no SDK version.
Its internal `responses-text-v1` policy, synthetic test endpoint (`api-version=1`) and synthetic
prices do not pin or qualify a production provider API version.

Checked on 2026-11-11 against the official
[OpenAI Responses create/streaming reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
and [Azure Responses guide](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses?view=foundry-classic).
The OpenAI example ends with `response.completed`, a response ID/model, completed status and
input/output/total usage, including cached-token details. Missing terminal usage stays `UNKNOWN`.
The current documented `cache_write_tokens` input bucket is outside this narrow adapter's
qualified pricing semantics; its strict parser rejects that shape, including zero values.
Documented sequence numbers and the full event corpus are not qualified by this slice.
Azure documents streaming through the `/openai/v1/` endpoint with deployment-specific model
configuration; the synthetic route and exact returned-model comparison are not a qualified Azure
deployment adapter. Neither documentation check proves independent settlement, exactly-once
provider execution, acknowledged local durability or physical stop after abort. These remain
closed-admission qualification blockers; no live provider request was used for this check.

`GET /v1/requests/:requestId` is a private control-authenticated version 1 status adapter. It returns
persisted attempt/scan/workspace/authority binding, outcome, approved policy digest, reservation,
validated usage and the local journal receipt. It excludes raw requests, responses, credentials
and ciphertext. A local receipt does not establish independent settlement or release a billing hold.
`NEVER_DISPATCHED` is recorded only when the gateway did not invoke the provider; the signed
record releases that request's local reservation and prevents reuse of its request ID, returning
`REQUEST_NOT_DISPATCHED` on replay. If the record is absent after restart or provider invocation
may have occurred, the hold remains uncertain.

## Closed default

`LYRASHIELD_RUNTIME_ADMISSION` defaults to `closed`. The service entrypoint rejects `open` until
the broker and independent-journal boundary have been qualified. Synthetic tests explicitly inject
open admission, a trusted test authorization callback and mocked/local provider traffic; they make
no paid provider calls. This work does not change production secrets, admission or deployment routing.

`LYRASHIELD_PROVIDER_ROUTES_JSON` configures fixed provider IDs, HTTPS base URLs, credential environment
variables, authentication modes, path prefixes and optional server `requestPolicy` descriptors.
Credentials stay in the gateway and are injected only upstream. The service binds to
`127.0.0.1:8791` by default. Required configuration:

- `LYRASHIELD_PROVIDER_GATEWAY_JOURNAL_PATH`
- `LYRASHIELD_PROVIDER_GATEWAY_SIGNING_SECRET` (at least 32 bytes)
- `LYRASHIELD_PROVIDER_GATEWAY_RESPONSE_ENCRYPTION_SECRET` (at least 32 bytes, provision separately)
- `LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN` (at least 32 bytes)
- `LYRASHIELD_PROVIDER_ROUTES_JSON`
- the provider credential variables named by the route configuration

Broker policy/digest and settlement integration, independent durable receipts, worker/engine adapter
integration, credential/process isolation, provider qualification and fault evidence are still
required before runtime admission opens. No production readiness or billing acceptance follows
from the synthetic tests.
