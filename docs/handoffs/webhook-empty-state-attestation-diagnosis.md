# Official attestation diagnosis (read-only, 2026-10-05)

CLI: /opt/homebrew/bin/gh, version 2.95.0 (2026-06-17).

## Reusable Actions fixture

Official artifact URL: https://raw.githubusercontent.com/cli/cli/v2.95.0/pkg/cmd/attestation/test/data/reusable-workflow-artifact
SHA256: 49a3aa6075e0f49f82843e74b5baa614ad2a588e6675612bf108a0a008c5ac25
Official bundle URL: https://raw.githubusercontent.com/cli/cli/v2.95.0/pkg/cmd/attestation/test/data/reusable-workflow-attestation.sigstore.json
Bundle SHA256: 88e35c3496fc9b9bd29629b69271bd32738e170f0d85a12d67da0c72c743f3bd
Both local files exactly match official v2.95.0 API Git blob hashes.
Bundle schema application/vnd.dev.sigstore.bundle.v0.3+json; Statement/v1; predicate https://slsa.dev/provenance/v1.
Certificate validity 2024-05-24 19:14:24–19:24:24 UTC. Verified Rekor timestamp 2024-05-24 19:14:24 UTC (integratedTime1716578064).
Certificate signer: github/artifact-attestations-workflows/.github/workflows/attest.yml@09b495c3f12c7881b3cc17209a327792065c1a1d.
Caller/build config: malancas/attest-demo/.github/workflows/shared.yml@refs/heads/main.
Source SHA95baf27389e83e6a5c48f42e190d48d7abcea19e; source repo804070735, owner16248153; manual; hosted; run9228858953 attempt1.

Original failing command (exit1):
gh attestation verify /tmp/lyra-disposable-attestation-artifact --bundle /tmp/lyra-disposable-attestation-bundle.json --repo malancas/attest-demo --signer-workflow malancas/attest-demo/.github/workflows/shared.yml --source-digest 95baf27389e83e6a5c48f42e190d48d7abcea19e --source-ref refs/heads/main --cert-oidc-issuer https://token.actions.githubusercontent.com --deny-self-hosted-runners --format json
Output: Error: verifying with issuer "sigstore.dev"
CLI v2.95.0 verification/sigstore.go256–263 discards underlying verifier error; GH_DEBUG was not used.
Underlying official sigstore-go v1.2.1 harness error, with the same SCT/tlog/observer requirements and default authenticated official TUF chain:
failed to verify certificate identity: no matching CertificateIdentity found, last error: expected SAN value to match regex "^https://github.com/malancas/attest-demo/.github/workflows/shared.yml", got "https://github.com/github/artifact-attestations-workflows/.github/workflows/attest.yml@09b495c3f12c7881b3cc17209a327792065c1a1d"

Corrected successful actual CLI command (exit0, 1 verified entry):
gh attestation verify /tmp/lyra-disposable-attestation-artifact --bundle /tmp/lyra-disposable-attestation-bundle.json --repo malancas/attest-demo --signer-workflow github/artifact-attestations-workflows/.github/workflows/attest.yml --signer-digest 09b495c3f12c7881b3cc17209a327792065c1a1d --source-digest 95baf27389e83e6a5c48f42e190d48d7abcea19e --source-ref refs/heads/main --cert-oidc-issuer https://token.actions.githubusercontent.com --deny-self-hosted-runners --format json
Output /tmp/lyra-disposable-attestation-corrected-result.json SHA25624af942cf08649112327db80873473a0538f81f665fd68be57b5e60f8ed83d7c.
Official trust: default public-good TUF embedded root, authenticated target from https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json; isolated-harness target SHA2566494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66. Fulcio https://fulcio.sigstore.dev, Rekor https://rekor.sigstore.dev. No custom-trusted-root, bypass, installed root change or authentication debug.

## Release fixture

Official artifact URL: https://raw.githubusercontent.com/cli/cli/v2.95.0/pkg/cmd/attestation/test/data/github_release_artifact.zip
SHA256 e15b593c6ab8d7725a3cc82226ef816cac6bf9c70eed383bd459295cc65f5ec3.
Official bundle URL: https://raw.githubusercontent.com/cli/cli/v2.95.0/pkg/cmd/attestation/test/data/github_release_bundle.json
Bundle SHA256 c8fb05f1a03f203c58bdc2a70913d5bece78f8fc5a4a09a05294a8798f3cbb8b.
Both local files exactly match official v2.95.0 API Git blob hashes.
Bundle v0.3+json, Statement/v1, https://in-toto.io/attestation/release/v0.1.
Certificate validity2025-03-10 15:03:02–2026-03-10 15:03:02 UTC; RFC3161 timestamp2025-05-30 20:13:39 UTC.
Certificate SAN https://dotcom.releases.github.com; no Actions OIDC extension; GitHub release-service certificate.
Original command (exit1):
gh attestation verify /tmp/lyra-disposable-gh-release.zip --bundle /tmp/lyra-disposable-gh-release-bundle.json --repo bdehamer/delme --predicate-type https://in-toto.io/attestation/release/v0.1 --format json
Output: Error: verifying with issuer "GitHub, Inc."
Isolated same-library GitHub official-root/signed-timestamp verifier safely exposes:
failed to verify certificate identity: no matching CertificateIdentity found, last error: expected SAN value to match regex "^https://github.com/bdehamer/delme/", got "https://dotcom.releases.github.com"
Thus this release-service fixture is unsuitable for testing the Actions-workflow identity contract, independent of present-day expiry.
Official trust: GitHub embedded anchor from cli/v2.95.0/pkg/cmd/attestation/verification/embed/tuf-repo.github.com/root.json SHA25698cba97be9075bc98b2322de3de85fbd1b70ec7392991dfd2f53d215bede1a8d; authenticated live TUF chain https://tuf-repo.github.com and target trusted_root.json. No custom root.

## Remaining scope

Official-root actual CLI verification is now positively proven against a genuine public Actions bundle. No new GitHub write permission is needed for this fixture diagnosis. Exact Lyra workflow/source/run/nonce canonical receipt issuance and full app verifier path remain separate disposable rehearsal gates. Any newly requested real issuance should be a separately reviewed disposable-only GitHub job granting contents:read, id-token:write, attestations:write, with no Azure login, environment secrets, RunCommand or production dispatch. Exact workflow SHA/job artifact digest must be determined from a concrete proposed job before requesting approval.
Only /tmp files were created; no repository edits or production actions.
