# Disposable worker financial-crash rehearsal

Run only with the reviewed, preloaded, canonical immutable worker image and its exact full product and engine commit IDs:

```sh
python3 .github/scripts/run-worker-financial-fence-drill.py \
  --candidate ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:DIGEST PRODUCT_SHA ENGINE_SHA \
  --receipt /private/new-financial-crash-receipt.json
```

The PostgreSQL and Redis images, and the worker image, must already be present; this command does not pull or build images. The selected product commit and its migrations must be available locally. The existing image reader fingerprint and ten financial source files are hashed against that commit before services are created. The immutable image digest and both image revision labels must match. Only the exact fixture namespace is removed; the receipt is never overwritten. A failed rehearsal still produces a failed receipt when its requested output can be written.

The worker is started on an internal-only disposable network with synthetic credentials and a least-privileged, non-bypass-RLS runtime role. The test driver enters via stdin; the only bind mount is a data-only receipt directory. It loads the image's actual `processScanJob` and denies and records child-process, HTTP and fetch calls. The original BullMQ delivery executes that entry point. A fixture-only PostgreSQL trigger pauses its claim transaction while a separate session queues a conflicting scan-table lock. The test confirms both waits before releasing the trigger, then confirms the table lock acquired, the worker is actually waiting behind it, exactly one claim committed, no manifest exists, and the original job remains active with a valid queue lock. It records the worker container PID/image/mounts and kills that container with SIGKILL. The same immutable image runs the original stalled job again, verifies its ID, nonce, timestamp, attempt and stall count, and requires `BILLABLE_PHASE_INTERRUPTED` with a held funded reservation and no process or HTTP dispatch attempts. Label-isolated cleanup is verified after both success and failure.

This tests the worker lifetime claim in a controlled process: the fixture trigger changes PostgreSQL scheduling, and driver instrumentation blocks process and HTTP dispatch. It does not test a real provider, the engine's physical spending ceiling, deployed routing or live workloads. The standalone JSON is **not** an OIDC-signed qualification and must not be promoted into a `financial-qualification` witness just because its `passed` value is true. A protected issuer must run this command itself against the release tuple, authenticate the resulting artifact, separately establish the exact engine CI and actual-image provider/SDK physical-ceiling evidence, and bind those distinct proofs and the tuple in its OIDC witness. Until those checks exist and pass, financial qualification must fail closed.
