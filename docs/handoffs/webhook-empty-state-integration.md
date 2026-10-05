# Default-disabled empty-scheduling cutover integration

This separate manual path must never assert a historical session timezone. The
UTC-v1 verifier and all four historical migration SQL files remain unchanged.
The current atomic runner remains production-disabled while this draft is
reviewed. No setup, dispatch, migration, backup or restore was performed.

The root policy and state paths are proposed installation targets, not installed
files. Approval must identify the GitHub OIDC deployment principal
`81173276-25ec-4737-bf28-12b814101d9f` (object ID
`b08289b5-8229-47bf-9d2f-7a8fcea7dfc1`), Contributor on the LyraShieldAI group.
This principal can execute arbitrary root RunCommand. Host files and attestations
are inside that trust boundary and do not isolate against its compromise.

The immutable receipt authorization binds source, original run/attempt/owner,
nonce, policy/producer hashes, and an explicit maximum 30-minute window. Each
phase must recheck root revocation, expiry, identities and owned admission.
Renewed observations cannot extend authorization. All six queue states on scan,
webhook retry and fix generation, scheduler/repeat counts, stopped writers,
zero-track and unresolved-parent counts fail closed on absence or ambiguity.
Fallback images must implement `durable-claims/2` and have exact image rehearsal.

Only official GitHub/Sigstore roots are accepted. No PEM, key path or custom trust
root is accepted in production. Certificate extensions and authenticated run
records bind signer workflow SHA, repository/owner IDs, source, run/attempt and
manual main execution. Fulcio has no environment extension: the protected
`azure-production` environment is enforced by the immutable pinned reusable
workflow, not a caller-controlled predicate assertion. Attest only the digest of
canonical receipt bytes. Raw identities and observations remain in root0600
files under root0700 run directories.

Pin rollout needs two reviews: first merge the disabled reusable workflow and
producer; then pin its actual merged commit in the caller and root approval
policy. A workflow cannot honestly pin its unknown future commit. The caller now pins actual integration commit
`3a403a845df0611762fc0e508de23b2a434fa837`; both workflows remain disabled by
an impossible decimal-run-ID sentinel, and every root mutator plus the original
atomic runner retains a literal false guard. The pin must be replaced with the
owner-approved reviewed production producer commit as part of a separate
activation review. No repository variable, permission, grant, secret or root file is
activated by this draft.

Backup restore uses the current run's exact object, ciphertext SHA-256, plaintext
SHA-256 and conditional ETag GET, never latest. R2 does not implement S3 object
versioning; ETag plus the ciphertext hash is the explicit object generation
binding. Logical backup DB identity must separately match the migration DB:
PRODUCTION_DATABASE_DIRECT_URL is not assumed equal to DATABASE_DIRECT_URL.
App connection identity remains unproven after the previous exec404; schema
similarity and host-only hashes cannot substitute for a readback.

Before activation, validate the entire root bundle on disposable services,
including dependency/path resolution, both migration URL aliases, artifact
acquisition and candidate preparation. The exact production app identity remains
unproven. Official-root CLI checks against two upstream public fixtures failed
(`verifying with issuer sigstore.dev` and `GitHub, Inc.`); unit fixtures and CLI
argument validation do not replace a successful keyless roundtrip. No custom
roots were installed to make those checks pass. Root collectors, trusted-v2
runner branch and phase/completion adapters are present but remain disabled and
must pass a complete disposable integration rehearsal before any owner approval
request for activation. Failure retains maintenance and additive schema;
there is no legacy rollback, queue deletion or payment replay.

## Review correction checkpoint

Executable admission actions now import their fixed runtime dependency correctly.
The migration adapter loads the root-owned fixed environment without shell
execution and binds both aliases to one approved direct/session endpoint. The
runner reacquires live root admission/fence/writer/queue/identity observations
before its SQL and reconciliation phases. Same-run recovery skips durable
completed phases and retains original authorization. Release uses a durable
intent and idempotent owned comparison so a crash after DEL cannot release a
foreign stop. Candidate health is checked independently of scan admission;
public scan readiness follows owned release, with an owned hold restored on
failure where possible.

The refreshed worker environment is checked by the startup fence before any
consumer starts. Inert prepared app/scanner candidates are probed using their
exact image and version-bound runtime connections before activation. Probe
values remain in child environments/private host memory, never command args.

The existing production-backup workflow is active: exact-object restore and
public-safe restore-proof changes therefore require ordinary review/CI before
merge even though every new cutover mutation path is disabled. Its documented
uselibpqcompat=1 option is normalized only for logical identity comparison;
endpoint/user overrides and duplicate options remain rejected. No live backup
or restore was run for this task.

Local verification checkpoint: 56 focused Node tests, actionlint on all three
changed workflows, shell syntax, and diff checks pass. Full hosted/postgres/image
rehearsal and reviewer confirmation of recovery/consumer startup integration
remain necessary. Docker is unavailable on this Mac; no root state was installed.

Official-root positive attestation roundtrip remains unproven. GitHub CLI 2.95.0
(2026-06-17) rejected the official public reusable-workflow fixture with
`Error: verifying with issuer "sigstore.dev"`. A second official release fixture,
with its correct repository/predicate, failed with
`Error: verifying with issuer "GitHub, Inc."`. Artifact hashes matched their
subjects. No custom trusted root or verification bypass was used. These failures
must be resolved before activation; certificate-policy unit fixtures are not a
substitute for a real verified canonical receipt roundtrip.
