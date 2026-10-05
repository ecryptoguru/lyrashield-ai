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
nonce, policy/producer hashes and an explicit maximum 30-minute window. Each
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
acquisition and candidate preparation. Production app identity remains unproven.
The public official Actions fixture now passes actual gh 2.95.0 verification
against the default official roots after correcting the signer workflow pin.
Exact Lyra canonical receipt issuance remains a separate gate. No custom roots
were installed. Root collectors and adapters remain disabled in the repository.
Failure retains maintenance and additive schema; there is no legacy rollback,
queue deletion or payment replay.

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

Local verification now includes 70 focused tests, an enabled copied candidate
adapter with cold startup and crashes after either activation, and an enabled
copied producer resume/rehold plus full workflow replay output test. All adapter
branches also receive an undefined-reference check. A copied enabled trusted-v2
runner passed real PostgreSQL 17 and Prisma 7.9.1 fresh/retry migration,
same-connection lock continuity and revocation/external-stop/unknown-writer/
soft-deleted-scan negatives. Root storage, cloud and attestation boundaries are
explicitly mocked in that disposable runner; the official CLI fixture validation
is separate. Production source guards remain false.

Hosted 6e98 smoke testing exposed package resolution from the wrong pnpm scope;
parser lookup now uses packages/db/package.json. The same Linux disposable image
exercise exposed Prisma's exported types entrypoint; host preflight now resolves
the actual prisma/build/index.js CLI instead. Docker 29.8.1 is available with
approved socket access; the earlier sandbox-only denial did not mean it was
unavailable. Latest hosted checks must pass on the corrected commit.

See webhook-empty-state-attestation-diagnosis.md for exact successful and failed
CLI commands, fixture hashes/schema/signing times, full identity error and
default official root provenance. The earlier failures were signer-policy
mismatches, not an established network, trust or expiry defect. No new GitHub
write permission was required. Exact Lyra receipt issuance is still unproven.

The root preflight now requires approved exact CLI version readbacks at fixed
/usr/bin paths before claiming admission. It verifies root-owned in-bundle
resolution of pg, pg-connection-string 2.14.0, Prisma 7.9.1, dotenv and tsx;
then it imports the actual migration runner and Prisma config with a harmless
placeholder URL. Installation must preserve the full workspace-relative layout,
all migration history, schema/config and locked dependencies under the fixed
bundle root. pnpm must be available at /usr/bin/pnpm. No installer was run.
A copied-layout subprocess smoke test exercises all four disabled adapters with
an empty ambient PATH and the actual parser package. A mocked shared-function
handoff exercises admission, scheduling census, receipt validation, all phases,
completion proof, candidate startup proof and release. This is not an enabled
adapter or real-service end-to-end rehearsal.

The preflight also validates the fixed secure migration environment before any
admission claim and runs a network-disabled import probe in the pinned observer
image. That probe requires the actual database/Redis constructors and all three
shared queue exports without instantiating clients or queue consumers.

The runner now keeps external worker/queue/admission checks separate from DB
continuity reads through its current locked connection, avoiding a collector
self-deadlock without hiding rows or dropping ownership checks. Completed-phase
replay returns the exact stored collect digest. Candidate promotion uses durable
owned activation intents, revalidates image/connection/completion bindings on
retry and polls boundedly for actual worker health. Backup collection normalizes
only logical identity; its credential hash always covers the raw URL.

Recovery regressions now cover Redis DEL success with a lost acknowledgment, a
committed resume journal rename followed by fsync failure, and config rename
interruption. Resume always reconciles owned admission and public readiness,
including when its journal already says complete. Unique owned config temporaries
allow retry without deleting an earlier interrupted temporary. Exact app/scanner
revision identity, image, Provisioned/Running/Healthy states and at least one
running replica are polled boundedly before candidate-ready is written. A failed
scanner with zero replicas cannot produce candidate readiness. These remain
enabled disposable-copy tests with provider and root-storage boundaries mocked.
Vitest excludes the Node-runner files; the dedicated rehearsal retains them.
