# Actual image paid-claim crash probe

This runs the packaged worker code against fresh, exclusively owned PostgreSQL
and Redis containers. No provider credentials or real provider requests are used.
The fixture reuses the production V2 funding admission function, the existing
restricted disposable worker role and the evidence drill's BullMQ lock/stall
timings. It does not use Vitest or replace the recovery processor.

```sh
# Explicit preload; the launcher itself never pulls.
docker pull postgres@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb
docker pull redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499

bash .github/scripts/run-cold-paid-claim-image-probe.sh \
  --candidate ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:DIGEST PRODUCT_SHA ENGINE_SHA \
  --receipt /private/new-cold-paid-claim-receipt.json
```

Requires a local Unix-socket Docker context, Python 3, Node/pnpm and installed
locked repository dependencies. The checkout must be the exact product source
recorded by the preloaded immutable worker image, and the two harness files must
match their committed bytes. A dedicated Prisma config avoids the developer's
`.env`. Fresh services accept no caller-supplied database or Redis URL. Host
migration credentials and in-image fixture credentials are fixed disposable
values; inherited provider credentials never enter the image.

The first real BullMQ callback calls packaged `claimEngineCapacity(2, ...)`,
which commits the lifetime `billable_boundary` event and funded RUNNING capacity
reservation through the restricted runtime role. A fixture-created user slot
already exists. The callback parks before invoking an engine or provider. The
launcher observes the committed checkpoint, SIGKILLs that exact container and
requires exit 137. A fresh packaged worker receives the **same** original job
through ordinary BullMQ stall recovery: two started attempts and one stall.

Recovery invokes the actual packaged `processScanJob`, which must return
`BILLABLE_PHASE_INTERRUPTED`. The entire scan, lifetime claim, funded reservation
and user slot must match their pre-crash snapshots. The reservation has no
stopped/settled receipt, and both engine and provider trap counts remain zero.
This proves that losing the original worker/job acknowledgement does not create
an automatic paid retry or free its held slot at that admission boundary.

The machine receipt records those observations, product/engine/worker identities,
harness file hashes, transcript checksum, the exact killed worker ID and exit
code, and verified fixture cleanup. It is emitted only after exact-ID, ownership
label and image checks confirm container removal and the network is removed.
Failed or ambiguous execution cannot produce a passing receipt.

The initial callback deliberately supplies the real funded-admission checkpoint
instead of running the full first-delivery scan pipeline. User slot creation is
fixture setup, not a new admission-route test. No accepted provider request,
provider settlement, complete scan execution, production startup, host failure,
database restore or physical invoice is exercised. Combine this with the native
engine lost-ack/SIGKILL, sandbox isolation and database epoch tests; rerun the
exact final native release images in the protected workflow before promotion.
