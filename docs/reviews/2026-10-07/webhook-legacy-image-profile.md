# Verified legacy webhook image profiles

## Cause and bounded correction

Release `37512959323` at main
`4257df1ca2c60a2328e2ee1db6dab4fe70a8eda6` stopped before image build.
Its live diagnostics verified protocol agreement and the complete pristine legacy
catalog. Only the historical worker/writer source and digest pins failed.

The classifier now recognizes two exact artifact profiles for the same reviewed
legacy webhook contract. Every writer must independently match its source and
web-image digest in one profile. The worker must match source, engine and
worker-image digest in one profile. Mixing reviewed revisions is allowed only
when each artifact matches its complete role-specific tuple. Cross-pairing or
swapping writer and worker digests remains rejected.

| Source                                     | Engine                                     | Web/writer OCI digest                                                     | Worker OCI digest                                                         |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `4822306e24f375800981bf282fd992a9c15dcde8` | `9d90be5aaf92f86bb5c1ba55a8138545764fdd44` | `sha256:dbc43686e11f95a03d9f163c865683e3949ade4179839ef6d268e6ea55f9b78f` | `sha256:d38f8b080ae62b88ba9c6273be76abff42adf5a86b831bde5b19f6d6fce466dc` |
| `3819345c9ccdc5e96ca7bfd389eaab8d7ea4c530` | `9d90be5aaf92f86bb5c1ba55a8138545764fdd44` | `sha256:42186658cc92ff0b9037420cfbddb6e54d32c8b9b4e141c2f0d98ed3e1ca9b98` | `sha256:35850652712814b2549ccb3f0a878c1214f6bfca075b350e3db6fcae58382791` |

## Evidence for the additional profile

- Approved VM-only inventory executed once from the reviewed script SHA-256
  `e2debc921ae9aec922dcb1ac36fd6ffed1bab6052819225271ec887b81f0d82e`
  against `LyraShieldAI/lyrashield-worker`. Its validated runtime source, engine
  and digest exactly match the second worker tuple above. Legacy migrations,
  columns, public schema, constraints, indexes and absence of transition columns
  all matched. The inventory made no business-data writes or service changes.
- Existing successful release
  [37027193354](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/37027193354)
  has exact head `3819345c9ccdc5e96ca7bfd389eaab8d7ea4c530`. Its build job
  [110904843067](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/37027193354/job/110904843067)
  records the two additional `containerimage.digest` values above, associated
  with the web and worker action image tags at that source. These are OCI image
  digests from build outputs, not `.dockerbuild` artifact-file checksums.
- Source comparison between the two revisions shows no change to webhook billing
  implementation, integration queues, web webhook routes, worker jobs, Prisma
  schema/migrations, lockfile, Dockerfile or deployment workflows. The billing
  source subtree difference is only `usage/balance.test.ts`. Both release
  workflows use the same engine pin. Unrelated MCP/agent UI and result-integrity
  changes exist; the whole product source is not byte-identical.

The VM report labels remote registry provenance `UNVERIFIED`. The GitHub package
versions API permission denial was respected; no alternate registry identity or
route was used. Build evidence was read from existing GitHub Actions records with
existing Actions access. It does not claim a cryptographic SLSA attestation.

## Controls retained and remaining verification

The classifier retains independent active-writer OCI/source checks, runtime image
and environment binding, exact protocol agreement, engine identity, migration
checksums and full catalog validation. Maintenance still requires owned admission,
drained work, excluded old writers and repeated pre-migration checks. All failure
and retry recovery behavior remains unchanged.

- Read-only Azure control-plane inventory used existing authenticated access and
  only `az containerapp revision list` for `LyraShieldAI/lyrashield-app` and
  `LyraShieldAI/lyrashield-scanner`, selecting active revisions' container images.
  Both applications had two active revisions: the first source and web digest
  above, and the second source and web digest above. All four references matched
  their complete role-specific profiles. The reviewed inventory script SHA-256
  was `72334d758f639aebd20b82882fe22613c82a45e208d098d7515025b54c0f12db`.
  No environment values, secrets, runtime commands or mutations were requested.

The inventory is a point-in-time observation. The protected classifier must
still prove that every active writer uses an admitted tuple on each release.
This correction does not authorize a release retry, migration, promotion, registry
access change or live checkout/accounting action. Required CI and independent
review remain necessary before merge. Full production cutover is not yet proven.
