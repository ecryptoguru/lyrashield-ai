# Wave H — CI/CD, Infrastructure & Supply Chain (Threat actor T4)

Baseline: `main` @ `3b289a43`. Domain: GitHub Actions workflows, published
composite action, container build/compose, ops shell + systemd units, pnpm
supply-chain controls, `.devin`/`scripts` maintainer tooling, worker-VM
promotion path.

- Files reviewed: 41 (10 workflows incl. inert `docs/marketplace` copy, `action.yml`, `Dockerfile`, `.dockerignore`, `docker-compose.yml`, 4 ops shell scripts + 5 systemd units + `capture-stop-provenance.sh`, 8 `.github/scripts` producers, `pnpm-workspace.yaml`, `package.json`, `run-all-tests.mjs`, 5 `.devin/scripts/*.py`, `provision-platform-admins.ts`, `verify-license-rls-live.sh`, `validate-kek-config.mjs`, `verify-worker-image.sh`, `live-test.ts` (head))
- Findings: 4 (0 Critical / 0 High / 4 Medium)
- Needs Verification: 4
- Note: `.devin/` and root `/scripts/` are gitignored — `.devin` tooling is local-only and cannot reach CI/prod via a commit. Root `scripts/` does not exist as a tracked path.

## Findings

### [VULN-H-001] Production secrets present in env while `pnpm install` executes dependency build scripts (Severity: Medium)

- Location: `.github/workflows/deploy-azure.yml:547-556` (`Run database migrations` binds `env: DATABASE_URL: secrets.DATABASE_DIRECT_URL` then runs `pnpm install --frozen-lockfile` in the same step); `.github/workflows/production-backup.yml:23-35` (workflow-level `env:` exports `PRODUCTION_DATABASE_DIRECT_URL`, `R2_BACKUP_*`, `BACKUP_ENCRYPTION_PASSPHRASE` into every job) + `:189-190` (`restore` job runs `pnpm install` under that env).
- Confidence: High (mechanism verified; exploitation requires a malicious/compromised package in the build-allowlisted set)
- Threat actor: T4 (supply chain)
- Issue: `onlyBuiltDependencies`/`allowBuilds` permit install-time code execution (`@prisma/engines`, `esbuild`, `msgpackr-extract`, `prisma`, `sharp`, `unrs-resolver`, `core-js`, `puppeteer`, `workerd`). Those scripts inherit step env; in both sites above, production credentials share that env although no install step needs them.
- Impact: One malicious release of a build-allowed dep exfiltrates the prod direct-DB URL (full data access) and, in backup, the backup passphrase + R2 write keys (backup theft/destruction).
- Evidence: `deploy-azure.yml:548-556`; `production-backup.yml:23-35,189-190`. Contrast: `provision-platform-admins.yml:60-61` runs `pnpm install` secret-free and binds secrets per-step — the correct pattern exists in-repo.
- Fix: Split `pnpm install` into a secret-free step; bind secrets at step scope only where consumed; never use workflow-level `env:` for secrets.
- v16Overlap: false. `deploy-azure.yml` touched by v16 `11d1a868` (OIDC only); exposure pre-exists, unchanged.

### [VULN-H-002] Deploy/backup tooling fetched unpinned at run time while holding production credentials (Severity: Medium)

- Location: `ci.yml:620-629` (`wrangler-action` with `wranglerVersion: "4"` + `secrets.CLOUDFLARE_API_TOKEN`); `production-backup.yml:78-82` (`docker run postgres:17-alpine` receives `PG_URL="$DATABASE_DIRECT_URL"`).
- Confidence: High (mechanism; requires upstream package/image compromise to fire)
- Threat actor: T4 (supply chain)
- Issue: Two prod-credential paths bypass the repo's own integrity controls (SHA-pinned actions, frozen lockfile, release-age). (a) Floating `wranglerVersion: "4"` installs newest wrangler 4.x at deploy time and hands it the prod Cloudflare token. (b) Mutable `postgres:17-alpine` tag receives the prod DB URL; no digest check.
- Impact: (a) Malicious wrangler 4.x → Cloudflare prod token → marketing Worker/config takeover. (b) Hijacked postgres tag → prod DB URL to image entrypoint.
- Evidence: `wranglerVersion: "4"` (ci.yml:626); `postgres:17-alpine` + `--env PG_URL` (production-backup.yml:79-81). Dockerfile bases are digest-pinned — these run-time-fetched tools are the exception.
- Fix: Pin `wranglerVersion` exactly (better: lockfile-managed devDependency so `minimumReleaseAge` applies); pin `postgres`/`redis` backup/service images by `sha256:` digest.
- v16Overlap: false (v16 `f6ee3d90` touched ci.yml tests only; marketing deploy job unchanged).

### [VULN-H-003] `minimumReleaseAge: 7` is seven minutes, not days — publish-age gate effectively absent (Severity: Medium)

- Location: `pnpm-workspace.yaml:76`.
- Confidence: High on semantics (pnpm interprets the bare number as minutes); Medium on intent (checklist expects a 7-day cooldown)
- Threat actor: T4 (supply chain)
- Issue: pnpm's `minimumReleaseAge` unit is minutes. `7` delays a freshly published version by 7 minutes — far short of a cooldown that lets registry/audit detection catch a malicious publish. Intended value is presumably `10080`.
- Impact: A malicious version lands on the next maintainer/CI `pnpm install` within minutes, gaining build-script rights where allowlisted — defeating the control the file advertises.
- Evidence: `minimumReleaseAge: 7`; adjacent `minimumReleaseAgeExclude` turbo pins prove the mechanism is live, so the unit error is a real gap.
- Fix: `minimumReleaseAge: 10080` (or intended duration in minutes).
- v16Overlap: false.

### [VULN-H-004] Shipped scan workflow runs unpinned `pip install safety` / `npx pnpm` in consumers' CI (Severity: Medium)

- Location: `lyrashield-scan.yml:156` (`npx pnpm audit` — unpinned pnpm from npm), `:172-178` (`pip install --quiet safety` — unpinned PyPI).
- Confidence: High (mechanism; requires upstream compromise)
- Threat actor: T4 (customer-facing supply chain — this is the documented gate consumers run via `workflow_call`, plus this repo's own PRs)
- Issue: Both fetch/execute latest published artifacts — no version pin, no hash, no release-age protection (npm/PyPI installs ignore `pnpm-workspace.yaml`). Job token holds `security-events: write` (read-only only for forked PRs).
- Impact: Compromised `safety`/`pnpm` release → arbitrary code exec in the scan job of every adopting repo: forged SARIF/code-scanning results, workspace tampering, `security-events: write` abuse.
- Evidence: `npx pnpm audit` (156) bypasses the pinned `packageManager`/`pnpm/setup` toolchain; `pip install --quiet safety` (173) no `==`/`--require-hashes`.
- Fix: Use pinned pnpm (`corepack pnpm audit`); `pip install safety==<ver>` ideally with hashes. (`npx lighthouse@13.0.1` in ci.yml:698 is exact-pinned — fine.)
- v16Overlap: false.

## Needs Verification

1. **Environment protection gates** — `azure-production` (deploy-azure.yml:331, configure-cloud-billing-admission.yml:46, provision-platform-admins.yml:31), `desktop-release` (release-tauri.yml:29/92/293), `cloudflare-production` (ci.yml:546). Environments are named; required-reviewer config is a repo setting invisible in code. If unset, green main merge ships to prod with no human gate.
2. **Scanner Container App secret scope** — deploy-azure.yml:831-872,1054-1106 sync GitHub App private key, webhook secret, Upstash, BullMQ creds to the public scanner origin. If no scanner path needs them, this is excess secret residency on the highest-exposure surface; verify code paths before trimming.
3. **`lyrashield-engine` visibility** — engine checkouts use `secrets.GITHUB_TOKEN` (deploy-azure.yml:105, release-tauri.yml:107/319, ci.yml:504), which cannot read a private cross-repo. Passing deploys imply it is public — confirm intent.
4. **`ADMISSION_CONFIG_TOKEN`** — configure-cloud-billing-admission.yml:60 is the last long-lived PAT (rest went OIDC in v16 `11d1a868`). Confirm fine-grained scope (env vars only) + expiry.

## Verified-safe (spot-checked, no action)

- No `pull_request_target`; `workflow_run` consumers require `conclusion == 'success'`, `branches: [main]`, `head_sha == origin/main`, and scope the routing artifact to `run-id` — stale/PR-origin runs cannot reach deploy-azure.
- All `uses:` across workflows + `action.yml` are full-length SHA pins (zero tag/unpinned).
- Manual prod dispatch requires `deploy:<source_sha>` + `source_sha == origin/main`; `build` gated to `refs/heads/main`; `deploy` alone gets `id-token: write` + env (v16 OIDC, `11d1a868` — noted, not re-reported).
- `provision-platform-admins`: choice-locked mode, exact confirmation phrases, TS-side two-email allowlist + TOTP/verified checks, serializable tx, session revocation; dispatch needs write (forks cannot trigger).
- `promote-worker-vm.sh`: digest-only promotion, OCI-label provenance re-verified on VM, empty-queue preflight before and at promotion, compare-and-delete admission-stop (pre-existing operator stop preserved), trap-driven rollback.
- ops shell: `set -eu`, fail-closed env/pin checks, sha256 enforcement, deny-by-default egress with public-IP validation, KV secrets newline-checked, `umask 077`+`mv` writes — no journal/log leakage.
- `production-backup`: gpg AES256 + sha256 metadata readback pre-delete, retention only after successful upload, restore drill verifies checksum/audit chain/app boot; no PR trigger.
- `action.yml`/scan workflow: allowlisted inputs, `--end-of-options` rev-parse, NUL-delimited file lists, jq-built SARIF, gate reads step `outcome` (not `conclusion`) so `continue-on-error` can't mask gitleaks failures.
- `Dockerfile`: all `FROM` digest-pinned, non-root `USER` in every shipped stage, no secrets in ARG/ENV; `.dockerignore` excludes `.env*`, keys, `.git`, `.devin/`; broad `COPY . .` confined to builder stages.
- `docker-compose.yml`: header-marked DEV ONLY, loopback binds, no prod claim.
- `ci.yml`: PR jobs carry dummy-only secrets; cache keys ref-scoped; `cancel-in-progress` is PR-only.
- `release-tauri`: tag↔version↔checkout triangulation, draft-only release, post-build codesign/notarization/entitlement checks incl. `get-task-allow` denial.
- `update-action-version`: `v2` retag gated to CI-green current `origin/main` (ancestor + equality checks).

## Residual risk (out of T4 scope / requires prior compromise)

- Merge-to-main auto-deploys on green CI; only possible human gate is env reviewers (NV-1).
- `secrets: inherit` passes the full secret store to the reusable deploy workflow.
- Worker container holds `/var/run/docker.sock` — engine compromise ≈ VM root (egress deny-by-default; sandbox isolation separate).
- `release-tauri` preflight binds all signing secrets at job level while running tag-controlled `desktop_release.py` (tag creation requires write).
- Mutable `v2` tag tracks latest green main — documented release mechanism.
- `run-worker.sh` runs a brief root container to chown shared root — bounded by digest pin.
