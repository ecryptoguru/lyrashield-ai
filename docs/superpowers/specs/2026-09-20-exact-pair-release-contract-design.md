# Exact-pair engine/worker release contract

## Decision and scope

The release authority is the exact app commit being released and the immutable engine commit pinned by that app commit. The existing engine-side `.lyrashield-worker-pin` remains an exact consumer revision for engine CI, but it is not an ancestry requirement for app releases. This allows GitHub squash merges without a post-merge pin repair.

This change concerns the cross-repository compatibility gate only. It does not change engine selection, scan behavior, billing, merge method, provider configuration, or the deployment's existing health and digest checks.

## Failure being corrected

Engine main `81cd6f70aacbc84a060a4970d537634837cec119` pins app PR branch commit `68a3190441ad81ddab2f6c5246d25c9f8234f3e8`. App PR #745 passed the engine/worker contract on its branch, then squash-merged as `e3bca197babf9f237980f19a4205b4d430c11ddf`. The merged app does not descend from the branch commit. App main CI skipped the contract, reported success, and started a production release that failed in its build job before image creation. Git ancestry was serving as a proxy for compatibility, despite the verifier already testing the current app checkout against the pinned engine.

## Required behavior

1. The app-side verifier accepts a clean checkout of any app commit, including a squash merge, only after validating the engine's consumer pin format, the declared test list, fixture equality, required engine CLI flags, and all declared worker contract tests against that **current app checkout**. A failed check blocks; no branch ancestry inference substitutes for test results. The engine-side CI continues to check out and test exactly its declared consumer pin.
2. App CI runs the pinned engine/worker contract on pull requests and main pushes. Its job is not skipped because the event is a main push or because path classification calls a change docs-only. The job name remains stable and becomes a required status check on app main, alongside existing required checks.
3. `release-production.yml` starts Azure deployment only after successful CI for the exact current app main SHA. `deploy-azure.yml` independently verifies that the pinned engine SHA is on engine main with required engine checks, then reruns the contract against the exact app SHA before building images. Existing current-main and deployment guards remain intact.
4. Neither verifier overwrites a dirty checkout. Missing pins, malformed SHAs, missing contract tests, fixture drift, missing flags, test failures, unavailable engine provenance, and stale release SHAs fail closed with actionable diagnostics.
5. The rollout uses a focused app PR. Before merge, the new required status must run successfully on the PR. After merge, verify app main CI, production release, exact deployed revisions/digests, and live readiness separately. No paid scan or provider purchase is part of this change.

## Implementation boundaries

- Remove only the app-side `merge-base --is-ancestor` check and its ancestry-specific message from `.github/scripts/verify-engine-worker-contract.sh`; retain its other validation and exact-current-checkout tests.
- Change `.github/workflows/ci.yml` so `Pinned Engine / Worker Contract` runs on both PRs and main pushes without a path-based skip. Add that job to app main's required status checks without removing existing checks or review rules.
- Add regression coverage using a synthetic squash graph: a non-descendant app commit reaches the substantive contract checks; dirty checkout and invalid/missing inputs still fail. Add a workflow assertion that the contract job cannot be skipped on main.
- Do not add a reconciler, GitHub App credentials, scheduled polling, duplicate release manifest, or merge-method policy change.

## Acceptance evidence

- Focused local script and workflow tests pass, with `git diff --check` clean.
- The app PR contract and other required CI checks pass; branch protection shows the contract as required.
- The merged app main SHA's CI has a successful (not skipped) contract job; the release workflow consumes that same SHA and succeeds through existing promotion and smoke gates.
- Production image/revision readback and live app, scanner, and worker readiness match the released pair. If a later CI, deployment, or live gate fails, report that gate explicitly rather than claiming production readiness.
