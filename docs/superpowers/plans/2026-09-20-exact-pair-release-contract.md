# Exact-Pair Engine Release Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a squash-merged app commit releasable only after its exact pinned engine/app contract passes required CI and deployment checks.

**Architecture:** Keep the engine's exact consumer pin for engine CI, but remove app ancestry as a release predicate. Run the existing substantive contract verifier on every app PR and main push, then rerun it in Azure deployment. Require that CI job in branch protection.

**Tech Stack:** Bash, GitHub Actions, Node `node:test`, GitHub branch protection API.

## Global Constraints

- No new bot, token, scheduled workflow, merge-method change, scan or billing mutation.
- Preserve engine SHA provenance, fixture equality, CLI flag checks, contract test execution and dirty-checkout denial.
- Preserve existing required checks, review requirements, current-main guard and deployment smoke gates.
- Work only on a focused branch and PR; never push directly to main.

---

### Task 1: Prove a squash commit reaches the substantive contract gate

**Files:**
- Modify: `.github/scripts/tests/worker-contract-worktree.test.mjs`
- Modify: `.github/scripts/verify-engine-worker-contract.sh`

**Interfaces:**
- Consumes: `bash .github/scripts/verify-engine-worker-contract.sh <engine-checkout> <app-checkout>`.
- Produces: exit 2 for an invalid or dirty checkout and substantive contract checks for a clean non-descendant app commit.

- [ ] **Step 1: Add the failing squash regression test**

Create a temporary app Git graph: `main` base commit, `reviewed` child commit stored in `.lyrashield-worker-pin` and a separate clean `main` squash commit that is not a descendant of `reviewed`. Set the declared contract path to `missing-test.ts`. Invoke the verifier and assert stderr includes `Missing worker contract test: missing-test.ts`, not an ancestry error. Keep the existing staged/unstaged dirty-checkout test unchanged.

```js
assert.equal(spawnSync("git", ["merge-base", "--is-ancestor", reviewed, "HEAD"], { cwd: app }).status, 1)
const result = spawnSync("bash", [path.resolve(".github/scripts/verify-engine-worker-contract.sh"), engine, app], { encoding: "utf8" })
assert.equal(result.status, 2)
assert.match(result.stderr, /Missing worker contract test: missing-test\.ts/)
```

- [ ] **Step 2: Confirm the test fails before the fix**

Run: `node --test .github/scripts/tests/worker-contract-worktree.test.mjs`
Expected: squash case reports the existing ancestry error instead of the missing-test error.

- [ ] **Step 3: Remove only the release-side ancestry rejection**

```bash
reviewed_app_sha="$(tr -d '[:space:]' < "$pin_file")"
if ! [[ "$reviewed_app_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Engine worker-consumer pin is not an immutable commit SHA." >&2
  exit 2
fi
# The engine tests its pinned consumer; this invocation tests this exact app checkout.
```

Retain all following clean-checkout, test-list, fixture, CLI and Vitest checks.

- [ ] **Step 4: Confirm focused tests pass and commit**

Run: `node --test .github/scripts/tests/worker-contract-worktree.test.mjs`
Run: `git diff --check`
Commit these two files with `fix(ci): test exact engine app pair after squash`.

### Task 2: Make the exact-pair check unavoidable in app CI

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/scripts/tests/worker-contract-worktree.test.mjs`

**Interfaces:**
- Consumes: existing `Pinned Engine / Worker Contract` job and exact engine SHA in `deploy-azure.yml`.
- Produces: one stable job status on every PR and main push, never a path- or event-skipped job.

- [ ] **Step 1: Add failing workflow regression assertions**

```js
const workflow = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8")
const job = workflow.split("  engine-worker-contract:")[1]?.split("  deploy-marketing:")[0]
assert.ok(job)
assert.match(job, /name: Pinned Engine \/ Worker Contract/)
assert.doesNotMatch(job, /\n\s+if:/)
```

- [ ] **Step 2: Confirm the test fails before the workflow fix**

Run: `node --test .github/scripts/tests/worker-contract-worktree.test.mjs`
Expected: assertion finds the current PR/path-only job condition.

- [ ] **Step 3: Remove the job-level `if` only**

Keep `needs: changes`, all setup steps, the immutable engine checkout, provenance verification and contract invocation. The existing workflow `on` already includes PR and main push.

- [ ] **Step 4: Confirm checks pass and commit**

Run: `node --test .github/scripts/tests/worker-contract-worktree.test.mjs`
Run: `bash .github/scripts/tests/test-classify-paths.sh`
Run: `git diff --check`
Commit with `fix(ci): require exact engine worker pair on main`.

### Task 3: Prove and release the change without bypassing protections

**Files:**
- Modify: GitHub app main required-status configuration (add `Pinned Engine / Worker Contract` only).
- Verify: `.github/workflows/release-production.yml`, `.github/workflows/deploy-azure.yml`, both immutable pins.

**Interfaces:**
- Consumes: app PR CI job status and existing one-review branch rule.
- Produces: required exact-pair check, PR merge after review/green CI, exact-main release evidence.

- [ ] **Step 1: Run final local gates raw**

Run: `node --test .github/scripts/tests/*.test.mjs`
Run: `bash .github/scripts/tests/test-classify-paths.sh`
Run: `corepack pnpm format:check`
Run: `git diff --check`
Inspect `git diff origin/main...HEAD` and verify no engine/runtime/pin change.

- [ ] **Step 2: Push a focused app PR and wait for CI**

Push `codex/exact-pair-release-contract`; create PR against app main. Confirm `Pinned Engine / Worker Contract` succeeds on the PR's current head and required security/build checks are green. Do not bypass the app's required approving review.

- [ ] **Step 3: Add the existing CI job to app main's required checks**

Read current protection first. Add `Pinned Engine / Worker Contract` while preserving the `SCA & Secret Scan` and `Lint, Typecheck, Test & Build` GitHub Actions checks, strict mode, one required review and admin enforcement. Read back all settings and the PR's mergeability.

- [ ] **Step 4: Merge only after protection passes, then prove deployment separately**

After required review and fresh green CI, squash-merge the PR. Verify the main CI run for the merged SHA has a **successful, not skipped** contract job. Verify `release-production.yml` targets that same SHA and passes image build, guarded worker promotion, Azure deployment and smoke. Read back deployed product/engine revisions and image digests, then probe app/scanner/worker readiness. Report any unproven provider, paid-scan or commercial gate separately.
