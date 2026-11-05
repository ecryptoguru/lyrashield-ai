# Task 9 — Held paired release automation report

## Status

Implementation is complete in an isolated product worktree at exact PR head
`1736ea1e78d4459e732d973dbb90f54bf2e21940`. Production activation remains closed.
No workflow was dispatched, pushed, merged, deployed or published, and no cloud,
customer, delegated or engine worktree was changed.

Implementation commit: `9f84a2ef`

## Delivered

- Added `.github/scripts/paired-runtime-workflow.mjs`, a finite controller with only
  `preflight`, `forward`, `canary`, `restore` and `release` actions.
- The controller verifies current source, authenticated owner, protected artifact
  provenance, exact run/environment binding and the action-specific arm or restore
  record before dispatching an operation.
- Added an explicit action map for `promoteHeldPair`, armed canary release, B-to-A
  restore phases (`begin`, `inspect`, `retry`, `finish`) and forward/restored release.
  Unknown actions, restore phases and release stages fail closed.
- Added a fail-closed `verifyPairedAuthority()` implementation. It always reports
  `paired broker/supervisor authority unavailable`; no proof boolean, environment
  switch or caller payload can make it succeed.
- Bound the qualified-release record to product, engine, sandbox, worker, web,
  egress-proxy, app/scanner/relay revisions, migration checksum, broker,
  supervisor and provider-gateway digests.
- Bound an archived qualified-fleet rollback tuple to the exact product, engine,
  images, named revisions and migration checksum. The rollback engine must match
  the candidate engine, its product/worker must differ, and its migration checksum
  must equal the forward tuple. This preserves forward-only schema rollback.
- Added an early read-only rollback availability check for exact registry images,
  both sandbox architectures and retained named Container Apps revisions.
- Wired an optional `qualified_release_digest` input into the deployment workflow
  and reusable runtime workflow. A non-empty digest triggers GHCR read access and
  the protected preflight before image build or production mutation.
- Restricted owner-token verification to `.github/workflows/deploy-azure.yml` and
  `.github/workflows/deploy-azure-runtime.yml`. Controller mutations must run from
  the runtime workflow; the caller workflow is accepted only for preflight.
- Automatic `release-production` routing does not supply a qualified-release digest,
  so this change does not activate the paired controller.
- Added focused package/Action release-surface matrix tests. They cover the three
  independently publishable packages, MCP registry identity, the finite Action
  modes and the mutable-only `v2` major tag.
- Added the focused controller tests to required path-scoped CI tooling coverage.

## Rollback behavior

The controller exposes the existing explicit B-to-A restore implementation rather
than relying on exit traps. Restore and release remain separate actions. Missing,
foreign, stale or unverified rollback evidence blocks before the broker/supervisor
authority gate and before any mutation. Existing failure containment remains
supplementary; it is not treated as rollback success.

## Verification

- `node --test .github/scripts/tests/paired-runtime-release.test.mjs .github/scripts/tests/paired-runtime-recovery-arm.test.mjs .github/scripts/tests/paired-runtime-live-trust.test.mjs .github/scripts/tests/paired-runtime-live-commands.test.mjs .github/scripts/tests/paired-runtime-transport.test.mjs .github/scripts/tests/paired-runtime-workflow.test.mjs .github/scripts/tests/release-surface-matrix.test.mjs` — 110 passed.
- `pnpm exec eslint` on all changed JavaScript and test files — passed with no warnings.
- `pnpm exec prettier --check` on all changed files — passed.
- `actionlint -shellcheck='' .github/workflows/*.yml` — passed.
- `pnpm lint:env-ownership`, `pnpm lint:copy-comma`, `node .github/scripts/verify-pnpm-pin.mjs` — passed.
- `pnpm lint:size` — passed; existing warnings did not grow.
- `pnpm format:check`, `git diff --check` — passed.
- `pnpm typecheck` — passed on the final code after the generated Prisma client was present. The first parallel run raced Prisma generation and integrations typecheck, then the same command passed on rerun.
- Path classification for the final file set reports `shared=true`, `ops-tests=true` and `azure-deploy=true`.

## Remaining blockers

- A real authenticated broker/supervisor authority implementation must replace the
  deliberate `verifyPairedAuthority()` failure. It must bind live authority and
  control-plane evidence without accepting caller-supplied proof booleans.
- Signed `qualified-release`, `hold-acquisition`, `arm`, `restore` and
  `qualified-fleet` artifacts must be issued by the protected store before a
  preflight can produce a successful receipt.
- `azure-production` must have the intended reviewer/environment protection and a
  controller caller must run from `deploy-azure-runtime.yml`. No such activation or
  workflow dispatch was performed.
- Package and Action matrix verification is source/configuration evidence only.
  Publication, vendor listings, authenticated clients and production runtime
  acceptance remain separate gates.
