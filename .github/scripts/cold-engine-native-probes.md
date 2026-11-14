# Cold engine native probes

Run only on an already loaded immutable current worker image. Python 3.12+, Git,
Docker with a Linux daemon, and the merged engine Git object are required. This
runner never pulls an image, installs dependencies, forwards host environment
credentials, mounts host paths into the image, or sends a paid provider request.

```sh
python3.12 .github/scripts/run-cold-engine-native-probes.py \
  --candidate ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:DIGEST PRODUCT_SHA \
  --engine-repo /path/to/lyrashield-engine \
  --harness-sha COMMITTED_PRODUCT_HARNESS_SHA \
  --receipt /private/new-cold-engine-native-receipt.json

python3.12 .github/scripts/tests/cold-engine-native-probes.test.py
```

The engine pin is `0793bcb9644a1985165963375586124c993c020a`. The harness must
match its committed Git object byte for byte. The engine's installed Python
package files must match that pin, and OpenAI, Agents SDK, LiteLLM and HTTPX
versions must match its lock. This verifies engine Python source and dependency
versions; it does not authenticate dependency bytes or OCI provenance. The
preparation workflow must independently authenticate the image and receipt
artifact. The old physical-ceiling drill remains historical and is not repinned.

Nine cases run in the actual installed engine with real loopback TCP inside a
read-only, capability-free Linux container with no external network. Responses,
Chat Completions and explicitly resolved native-client LiteLLM each exercise
streaming and ordinary calls against a controlled 503. Each must make one
physical POST, put a 128-token output cap on the wire, and retain its pending
charge. The aggregate case makes repeated uncertain requests against a $0.002
test cap and must deny the next request before TCP dispatch. Lost acknowledgement
and SIGKILL cases use the engine's existing financial durability scenario: a
pending reservation must already be on disk at provider acceptance, and a fresh
interpreter must refuse another POST while retaining that reservation.

The machine receipt binds source revisions, worker digest and local image ID,
architecture, harness file hashes, engine Python fingerprint, SDK versions,
exact executed case names, exit codes, transcript checksum and confirmed cleanup.
Only the uniquely acknowledged container ID can be removed. An unknown create
acknowledgement or unverifiable cleanup fails the run and requires ordinary
ownership reconciliation before retry. Operational subprocess output is not
printed or persisted; only its checksum is included.

These engine cases do **not** prove the actual worker's PostgreSQL claim, Redis
redelivery, user slot retention, actual untrusted sandbox credential/egress
isolation, database restore replay barrier, live provider settlement or image
provenance. Those are explicit `unverified` fields; a cold release consumer must
keep its gate closed until it has separate actual evidence for them. Validation
unit tests and development runs on other source/platforms cannot qualify native
behavior.

## Native sandbox isolation mode

Add `--sandbox-image ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:DIGEST`
and `--docker-socket /var/run/docker.sock` to run the separate sandbox probe.
Both immutable images must already be loaded. This creates a trusted controller
with the explicitly selected local Docker socket and root fixture identity;
it must run only against the disposable/local fixture daemon. It never changes
or restarts that daemon. The actual untrusted sandbox receives no socket or
host mount, and its engine `session.exec` operations run as `pentester`.

The installed engine's `docker_backend`, `build_sandbox_environment`, network
admission, session execution and native deletion are exercised on two actual
selected sandbox containers. Dummy provider keys remain in the controller only.
The test checks sandbox Docker environment, non-root process environment and
procfs reads, absence of the controller's private file and Docker socket, and
absence of host mounts, privileged mode and host PID namespace. It starts real
listeners, establishes positive loopback and outside-provider canaries, then
requires sibling and outside-provider direct TCP denial in both directions on
the actual internal bridge with ICC disabled. No real provider request is sent.

This emits `lyrashield.cold-sandbox-native.v1` with the sandbox index, actual
native image configuration ID, owned resources and verified deletion. The
parent preparation workflow must bind the index's authenticated native platform
manifest separately; local Docker image labels do not authenticate it. The
fixture uses an empty manifest and no source/attachment/policy mounts. It does
not qualify full target-relay grant policy, arbitrary repository mount contents,
worker DB/Redis crash behavior, production host routing or live billing. Failed
or incomplete native execution cannot satisfy the cold release gate.

## Budget authority audit

`runner-process.ts` polls engine spend every 15 seconds and uses a 10% overshoot
grace. A missing/malformed spend receipt or read failure does not terminate the
child; that poll is an observational backstop, not per-request financial
authority. `execution.ts` resolves the profile/policy/plan cap, rejects zero,
and passes the positive cap to `runEngine`; `command-builder.ts` sends it as
`--max-budget-usd`. In the merged engine, `ReportUsageHooks` reserves the next
request in the filesystem journal before dispatch, and `physical_requests.py`
authorizes that durable reservation while enforcing the on-wire output cap and
one POST. Unknown charges remain pending and block a new interpreter's resume.
These native probes exercise that authority even when no completed usage exists.
Changing the spend poll to fail on every initial missing receipt would kill
legitimate startup and would still not establish an on-wire budget cap.

The existing product lifetime `billable_boundary` scan event is separate from
the engine journal. It is checked under a locked scan row before a funded retry.
That source invariant is not proof of actual Docker worker crash, redelivery or
database rollback behavior; those require their own disposable-services drill.
