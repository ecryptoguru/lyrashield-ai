# Protected sandbox publication verification

`runtime-qualification-foundation.mjs` is a protected, read-only verifier. It does
not issue qualification, publish artifacts, exchange Azure credentials, or change
the unconditional production and worker holds. The protected reusable issuer
consumes that verifier and managed-signs only an internally constructed held
publication record. The worker can authenticate and bind that record to its
exact image and engine; it still rejects admission for missing independently
measured native inventory and runtime authority. There are no deployment outputs.

The manual `qualify-runtime-issuer.yml` workflow accepts an optional
`fresh_sandbox_publication` selector containing exactly `engineRevision`,
`publicationRevision`, `sandboxDigest`, `publishRunId`, and `publishAttempt`.
The selector only identifies what to verify. It cannot supply a record, saved
verification JSON, evidence file, tool path, trust root, or signing payload.
An empty selector preserves the existing health-only check.

The protected reusable job authenticates its current main identity, then invokes
the byte-pinned verifier to fetch actual OCI bundles for provenance, selected
runtime/platform binding, and bounded coverage. Every predicate must independently
pass cryptographic verification, the exact workflow/source/subject/repository
identity and publication run/attempt checks. Coverage must match the shared worker
policy, including distinct amd64/arm64 receipts, native manifest concordance,
all twelve Go applications, bounds, scopes, and limitations. The selected runtime
revision may differ from the publication workflow revision; both remain bound.

`issue-sandbox-publication.mjs` authenticates the protected main issuer before
candidate reads, verifies all three predicates before credential exchange,
and constructs `lyrashield-held-sandbox-publication/1` internally. It uses the
existing fixed managed RSA key version and verifies the returned signature
against the shared source-controlled public key. Login, signing and verification
failures log out and return no record. Caller bytes are never signing payloads.
The artifact retains the exact signed JSON bytes and signature together.

The record binds the selected engine, publication workflow revision and run,
image index, distinct native manifests, issuer source/run and a maximum 24-hour
validity. `signedBoundedCoverageVerified` is true; `qualified`,
`nativeInventoryRechecked`, and `runtimeAuthorityVerified` must remain false.
Its coverage checksum hashes the verified predicate's JSON rendering. This
authenticates publisher claims; it does not independently remeasure native
bytes, validate the referenced engine CI run or release admission. A fresh
build produces a fresh digest and cannot qualify a retained image by implication.

The protected Ubuntu job provisions GitHub CLI 2.95.0 from the fixed official
amd64 release archive, checks both the archive and extracted executable hashes,
and installs only the exact binary as root-owned `/usr/bin/gh`. Downloads have
explicit time and retry bounds. The adapter independently rechecks the installed
binary before use; unavailable OCI bundles fail closed. This provisioning is
workflow-only and was tested with mocked commands, without a local install or
download. The new Linux provisioning/OCI/signing composition has not been run
in hosted CI. Local cryptographic verification does not qualify that environment.

The host runtime configuration may select only
`LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH=/etc/lyrashield/sandbox-publication-record.json`.
`run-worker.sh` requires a root-owned mode-0444 regular file, rejects symlinks,
and binds it read-only outside the worker-writable shared root. Inherited process
values cannot select this control. The worker reads through the existing bounded,
race-checked evidence reader and verifies exact signed bytes, fixed key version,
schema, image/engine and expiry. Even an authentic held record fails admission;
the legacy eight-key coverage path remains available when no record is selected.
No artifact download, host installation of the record or production action is
wired into these workflows.

`verifySandboxAttestationBundle` takes a raw Sigstore v0.3 bundle and an expected
sandbox digest, publication source revision and publication run/attempt. It invokes the
byte-pinned GitHub CLI against that exact OCI subject with the raw bundle in a
private temporary file. It requires successful cryptographic verification under
the CLI's default Sigstore/GitHub trust roots, GitHub-hosted execution, the immutable engine repository
and owner IDs, main ref, source and signer revisions, and the exact publication
workflow. It checks run/attempt in the certificate's `runInvocationURI` as well
as in the provenance predicate. Supplied saved `gh` verification JSON is rejected.
The predicate alone is never identity proof. Ambiguous results fail closed.

The exact `--cert-identity` value includes the signer workflow and main ref.
GitHub CLI v2.95.0 makes it mutually exclusive with `--signer-workflow`, so the
adapter supplies only the exact identity flag. Verified certificate output must
still match both `subjectAlternativeName` and `buildSignerURI`. The argument
regression test uses the official version's flag groups as an independent
contract rather than inferring compatibility from mocked verification output.

The returned frozen result is constructed internally and explicitly carries
`qualified: false` and `packageCoverage: UNVERIFIED`. It is a provenance check,
not a `qualified-fleet` record, a native-image/package-coverage receipt, or a
promotion action lease. Expected inputs are comparison targets, not trusted
release authority. An attested image index does not independently establish its
native amd64/arm64 manifests, extracted package contents or runtime behavior.
The publisher can check out a selected runtime revision separately from its own
workflow source. This check's `publicationRevision` binds the signed publication
source; it does not independently establish that selected runtime's engine
revision. That requires the separate authenticated qualification predicate and
independent image/runtime evidence.

The production process adapter accepts only Linux `/usr/bin/gh`, owned by root
and without group/other write permission, with the exact v2.95.0 binary SHA-256
for amd64 or arm64. There is no PATH lookup, caller-provided executable or custom
trust root. Provisioning runs only for the optional publication check; an empty
selector preserves the existing health check. The `run` test seam is trusted test
code and is never a workflow input or a saved verification result reader.

The binary pins were derived after checking these official release archive
SHA-256 values and extracting only their `bin/gh` member in memory:

| Architecture | Official archive SHA-256                                           | Extracted binary SHA-256                                           |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| amd64        | `25d1e4729e8808c9ed3d613e96ebd3f3e44446f2d368c89d878a71a36ddb3d8c` | `62c11fbaa08835168c3d1acf8a645ac6268a13a5682c73581388c9df0c622617` |
| arm64        | `d41e0b3b6218e5741c8bb4db39b16e53a59e0e06299a8489bd38f623ef7ebaae` | `706b030846db08d0dac0392d6f74416e0bbf0d9ac5ecbd54c9046305c10eac59` |

Sources: [GitHub CLI v2.95.0 release](https://github.com/cli/cli/releases/tag/v2.95.0),
[verifier policy](https://github.com/cli/cli/blob/v2.95.0/pkg/cmd/attestation/verify/policy.go),
[certificate JSON layout](https://github.com/sigstore/sigstore-go/blob/v1.2.1/pkg/fulcio/certificate/summarize.go)
and [certificate extension meanings](https://github.com/sigstore/sigstore-go/blob/v1.2.1/pkg/fulcio/certificate/extensions.go).

## Remaining issuance boundary

`issueRuntimeQualification` always throws before credential exchange. Production
issuance requires independently authenticated readers for all of the following:

- Native amd64/arm64 image bytes and manifests, bounded package inventory and
  exact coverage, engine and worker test receipts, and genuine tested source trees.
- The exact product/engine, worker/web/proxy/sandbox tuple and separate broker,
  supervisor and provider-gateway identities.
- Runtime policy and migration checksums, independent journal proof, authority
  epoch, coherent rollback archive, and protected fleet readback. Missing or
  uncertain authority cannot be replaced by a caller-provided `passed` boolean.
- Full runtime record construction and managed RSA signing outside
  worker-writable paths, with protected storage. The held publication record
  implements only the authenticated publication portion of that boundary.
- A separate signed 15-minute promotion lease bound to the record hash, tuple,
  action, consumer run/attempt, authority epoch and nonce, with durable replay
  protection checked before every mutation and admission release.

The paired consumer's reviewed `lyrashield-qualified-fleet/2` boundary uses the
`schema` field (not `schemaVersion`) and requires `migrationChecksum`,
`brokerDigest`, `supervisorDigest`, `providerGatewayDigest` and
`runtimePolicyDigest` in `controlPlane`. Its existing proof hashes do not supply
the missing native inventory, journal, rollback or lease authority. This verifier
does not manufacture a record that would satisfy that consumer.

The unit tests use synthetic verifier output only to exercise policy, tamper,
ambiguity and replay rejection. They also use locally signed RSA OIDC tokens to
show issuer identity failures happen before mocked Key Vault operations. Existing
health tests cover the fixed actual managed-key signature. Locally generated RSA
keys exercise exact held-record signatures, tampering, wrong keys, image/engine
mismatch, expiry and admission upgrades. Issuer and host tests cover verification
before signing, failure cleanup, fixed paths and read-only ownership controls.
No production credentials, native candidate qualification or live held-record
issuance are established by these tests.

A separate 2026-11-11 offline smoke check executed the exact SHA-256-pinned
v2.95.0 ARM64 binary in the cached Linux image
`sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54`,
with networking disabled, a read-only filesystem, no capabilities and an
unprivileged user. The old identity-flag combination reproduced the CLI parser
failure. The corrected combination successfully verified GitHub CLI's real
[`actions/attest-demo` wheel fixture](https://github.com/cli/cli/tree/v2.95.0/pkg/cmd/attestation/test/data),
and modified artifact bytes failed verification. This smoke check used a local
artifact instead of an OCI registry subject and pre-fetched official default
roots through `gh attestation trusted-root`, supplied with the offline-only
`--custom-trusted-root` flag. The production adapter exposes no custom-root
interface. No actual LyraShield image bundle, native runtime or production
qualification was verified by that smoke check.
