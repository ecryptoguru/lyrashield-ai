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
policy. A workflow cannot honestly pin its unknown future commit. The literal
false caller gate remains until this actual commit pin and owner-approved setup
are reviewed. No repository variable, permission, grant, secret or root file is
activated by this draft.

Backup restore uses the current run's exact object, ciphertext SHA-256, plaintext
SHA-256 and conditional ETag GET, never latest. R2 does not implement S3 object
versioning; ETag plus the ciphertext hash is the explicit object generation
binding. Logical backup DB identity must separately match the migration DB:
PRODUCTION_DATABASE_DIRECT_URL is not assumed equal to DATABASE_DIRECT_URL.
App connection identity remains unproven after the previous exec404; schema
similarity and host-only hashes cannot substitute for a readback.

Remaining integration gates in this draft must be closed before activation:
root-owned fixed collectors, authenticated rehearsal and exact restore proof,
producer/canonical attestation roundtrip, atomic runner v2 integration, and phase
orchestration/completion proof. Failure retains maintenance and additive schema;
there is no legacy rollback, queue deletion or payment replay.
