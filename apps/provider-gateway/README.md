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
applies. At most eight provider calls can be active in one service instance.

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
`UNKNOWN`. Usage identity authenticates the request/attempt and terminal token buckets; it is
not derived from the output hash. This narrow adapter does not support other provider APIs or
usage/cache-write shapes.

Completed bytes, status and the allowlisted forwarded headers are encrypted with AES-256-GCM using
a separately configured secret and request/response identity as authenticated associated data.
The signed journal records the encrypted response and terminal usage before any completed response
is returned. An exact duplicate decrypts and verifies those retained bytes and never contacts the
provider. A lost result acknowledgement closes local admission; restart can replay a durable
completed result. Unresolved restart records receive a durable `UNKNOWN` result. Legacy HTTP/hash-
only successes receive a separate uncertainty event without rewriting their historical records.
Wrong encryption keys or invalid retained bytes fail replay and never cause resubmission.

The service buffers the bounded response until terminal validation and durable retention complete.
It preserves exact SSE bytes but does not yet stream incremental bytes to the engine/client.
Retention currently uses the bounded local signed journal; managed key rotation, external encrypted
object retention, capacity/lifecycle qualification and independent settlement remain outstanding.

`GET /v1/requests/:requestId` is a private control-authenticated version 1 status adapter. It returns
persisted attempt/scan/workspace/authority binding, outcome, approved policy digest, reservation,
validated usage and the local journal receipt. It excludes raw requests, responses, credentials
and ciphertext. A local receipt does not establish independent settlement or release a billing hold.

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
