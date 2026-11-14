# Runtime evidence transport

`runtime-fleet-evidence-transport.mjs` transports already observed, immutable
records inside the protected `issue-runtime-qualification.yml` job. It does not
run acceptance cases, fill missing facts, issue runtime grants, or create a
rollback baseline.

The native producer must export a root-owned, non-writable directory at
`$RUNNER_TEMP/lyrashield-runtime-fleet-evidence`, with six root-owned,
non-writable regular files (one link, at most 4096 bytes, strict UTF-8):

- `native.json`, `migration.json`, `policy.json`, `journal.json`: exact accepted
  evidence records. Every record binds the current source, run attempt and
  canonical full fleet hash. Missing native checks or immutable journal proofs
  remain unavailable; mutable journal heads do not substitute for seals.
- `rollback.json`: the actual independently retained `qualified-fleet/2` archive.
- `rollback.locator.json`: that archive's existing `runId`, `attempt`,
  `artifactId` and `source`. The transport never generates the prior archive.

The release repository variable `LYRASHIELD_RUNTIME_FLEET_EVIDENCE` supplies only
`{"rollback":"<archive SHA-256>","inventory":{...}}`. The inventory object uses
the existing exact independent publication/verifier selectors. Current-run
native, migration, policy and journal hashes are rejected in this configuration;
they are calculated from the producer's actual bytes.

The `witness` phase validates these records, obtains digest-bound GitHub OIDC
witnesses and writes private body copies. Four `upload-artifact` steps publish
only the witnesses under the existing `paired-v1-<run>-<attempt>-evidence-<hash>`
names. The `locate` phase binds the real uploader artifact IDs, authenticates the
downloaded witness archives through `verifiedArtifact`, and emits exact
current-run selectors for the managed issuer. No OIDC token is printed.

The installed native producer and immutable seal/pin publication must exist
before this path can qualify a release. Missing files, unsafe permissions,
unobserved checks, mismatched hashes, absent rollback, or failed artifact
authentication retain the deployment hold.
