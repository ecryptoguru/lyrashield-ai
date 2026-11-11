# Protected qualification verifier foundation

`runtime-qualification-foundation.mjs` is a protected, read-only verifier. It does
not issue qualification, publish artifacts, exchange Azure credentials, or change
the unconditional production and worker holds. The reusable issuer can now
authenticate a fresh sandbox publication before its fixed health signature;
it has no runtime-signing or deployment outputs.

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

The uploaded result is `lyrashield-sandbox-publication-verification/1`, with
`signedBoundedCoverageVerified: true`, `nativeInventoryRechecked: false`, and
`qualified: false`. Its coverage checksum hashes the verified predicate's JSON
rendering. It authenticates the publisher's claims; it does not independently
remeasure native bytes, validate the referenced engine CI run, issue fleet
authority, or release admission. The issuer still needs those independent
readers and managed runtime signing before promotion can be enabled. A fresh
build produces a fresh digest; it does not qualify or reproduce a retained image
by implication.

The protected workflow does not install tools or log in to a registry. Its exact
root-owned Linux `/usr/bin/gh` binary and registry read access must already be
available; missing or different tool bytes and unavailable bundles fail closed.
Local verification through a trusted test adapter does not qualify that hosted
process environment.

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
trust root. Tool installation is deliberately not wired to the health workflow;
an absent or different binary fails closed. The `run` test seam is trusted test
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
- Canonical immutable record construction and managed RSA signing outside
  worker-writable paths, with explicit validity limits and protected storage.
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
health tests cover the fixed actual managed-key signature and mocked signing
failures. No production credentials, native candidate qualification or live
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
