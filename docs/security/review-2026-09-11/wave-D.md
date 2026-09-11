# Wave D — Scan pipeline, worker, sandbox, evidence, fix-PR

Baseline: `main` @ `3b289a43`. Threat actors: T3 (malicious scan-target repository),
T2 (tenant abusing scan configuration), T1.
Dedupe manifest: `docs/security/review-2026-09-11.v16-dedupe.md`.
Scope: scan pipeline + BullMQ worker, worker→Python-engine subprocess boundary, Docker
sandbox, deterministic TypeScript scanners, evidence/findings integrity, fix-PR execution,
URL/API SSRF + egress, worker operational scripts.

- Files reviewed: ~38 — run-scan.job.ts, queue.ts, ScanJobDataSchema (types/index.ts),
  engine/{runner,command-builder,output-parser,engine-output-schema,finding-persister,
  result-integrity,deterministic-retest,stale-resource-reaper,scanner-orchestrator,
  workspace-path,evidence-storage}.ts, scanners/{url-scanner,url-behavior-probes}.ts,
  fix-generate.job.ts, packages/fix/{diff-validator,build-diff}.ts,
  packages/integrations/github.ts, packages/security/{ssrf,safe-fetch,
  egress-proxy-client}.ts, web routes (targets, scans, fix-proposals, create-pr,
  findings/[id]), fix-pr-context.ts, fix-pr.ts, preflight.job.ts, ops/worker/*
  (run-worker.sh, refresh-egress.sh), Dockerfile, docker-compose.yml.
- Findings: 0. Needs Verification: 5.

## Findings

None. Every attacker-controlled path traced from hostile repository/configuration content
to worker execution, sandbox resources, cross-tenant data, evidence, billing, or findings
integrity terminates at a concrete fail-closed control. Residual concerns that could not be
resolved to a confirmed exploit path are under Needs Verification.

## Needs Verification

1. **Fix-path `..` traversal not normalized — blocked only by GitHub API semantics.**
   `packages/fix/src/diff-validator.ts` `normalizePath()` strips `a/`/`b/` and converts
   `\`→`/` but never collapses `..`/`.` segments; the forbidden-path check is a raw
   `startsWith(".github/")`/`startsWith(".git/")` prefix test. An engine-emitted
   `code_locations[].file` (repo-influenced via prompt injection of the model) like
   `x/../.github/workflows/ci.yml` passes both the forbidden check and the anchor/implicated
   allow-set. Execution reads each file via `getFileContent()` — path `encodeURIComponent`ed,
   so GitHub receives literal `x%2F..%2F.github%2F...` → expected 404 → throw, fail-closed —
   before `createOrUpdateFile()` writes the same path UNencoded → WHATWG URL normalization
   collapses `x/../` → targets `.github/workflows/ci.yml`. Exploitable end-to-end ONLY IF
   GitHub's contents API resolves `..` server-side on the read (then read/write agree). A
   successful write adds a workflow to a same-repo PR branch that runs on `pull_request`
   events → repo secret exfiltration. Cannot confirm GitHub `..` resolution without API
   testing. Defense-in-depth fix regardless: reject `..`/`.` segments and control chars in
   `normalizePath`; `encodeURIComponent` the path in `createOrUpdateFile`. Interaction: v16
   `79700836`/`bb8ea8bb` touched loop-closure around this flow, not these files —
   `v16Overlap: false`.
2. **`isValidGitRef` accepts leading `-` branch names.**
   `packages/types/src/index.ts:148` rejects `@`, `/` edges, `..`, `@{`, whitespace, control
   chars, `~^:?*[\]` — but not a leading `-`. A stored branch `-x` reaches the engine as
   `--repository-branch <value>` (argv array, no shell). Deterministic retest independently
   rejects `startsWith("-")` — the validators are inconsistent. Concrete harm requires the
   engine CLI / its git invocation (sibling `lyrashield-engine`) to treat the value as an
   option — unverifiable from this repo; git itself rejects `-x` as a ref. Fix: mirror the
   `-` rejection in `isValidGitRef`.
3. **Engine argv has no `--` end-of-options separator.**
   `apps/worker/src/engine/command-builder.ts` builds argv arrays; all target-derived values
   are persisted, schema-validated fields. Option-injection needs the engine's parser to
   misbehave on adversarial values — engine argparse is in the sibling repo. Low risk;
   add `--` before positional operands if the engine CLI supports it.
4. **Sandbox isolation flags live in the sibling engine repo.**
   `run-worker.sh` mounts the Docker socket into the worker (required to spawn sandboxes) and
   sets `LYRASHIELD_ENGINE_SANDBOX_NETWORK` + pinned `LYRASHIELD_IMAGE`. Worker-side controls
   are strong (`--cap-drop ALL`, `no-new-privileges`, mem/PID limits, tmpfs, digest-pinned
   images, provenance from OCI labels, fail-closed readiness), but the actual `docker run`
   flags for analysis sandboxes — cap drop, read-only rootfs, network mode, egress — are
   engine-internal. A malicious repo executes inside the sandbox; whether it can reach the
   socket, the worker network, or arbitrary egress is unverifiable here. Also verify
   `refresh-egress.sh` DOCKER-USER rules cover the sandbox network in production, not only
   the worker subnet.
5. **Engine-reported usage feeds billing.**
   `output-parser.ts` bounds `llm_usage`/`total_cost_usd` (≤ $1M DECIMAL(12,6), ≤10k request
   entries, per-model bucket reconciliation, unpriceable receipts stay unpriceable), and
   worker policy caps bound charges — but the engine is the sole meter. Whether hostile repo
   content can prompt the engine into fabricating/inflating usage receipts is engine-side.
   Worker-side handling is fail-closed.

## Verified safe (high-confidence)

- **BullMQ authority**: `ScanJobDataSchema` is 6 benign fields; producer sends no
  authority-bearing values. Consumer prompt-injection-checks payload strings, zod-validates,
  reconciles `scanId`→canonical DB row, rebinds workspace/target/policy from persisted rows,
  disables retries past the billable boundary. Forged jobs without a real scan row rejected;
  replaying one's own scan is self-harm only.
- **Engine subprocess**: `spawn` argv arrays (no shell); `buildEngineEnv` allowlist excludes
  DATABASE_URL/Redis/KEK/billing secrets; bounded stdio; timeout + inactivity + LLM-stall +
  cancellation + budget termination; sandbox cleanup verified via `docker ps -a` on validated
  scan label; workspace cleanup under fixed worker-owned roots.
- **Deterministic retest checkout**: git argv arrays, hooks disabled, file/ext protocols
  forbidden, symlink/submodule/LFS rejection, size + file-count caps, detached exact 40-char
  revision, dedicated capped tmpfs, cleanup on all paths, `-`-prefixed branch rejected.
- **URL/API SSRF**: https-only; no creds/query/fragment; private/loopback/link-local/
  metadata/reserved/IPv4-mapped-IPv6/alternate-encoding rejection; trailing-dot handling;
  DNS pinning via dispatcher; manual per-hop redirect revalidation; byte limits;
  revalidation at preflight AND scan time; production requires authenticated egress proxy;
  probes restricted to GET/HEAD/OPTIONS with redacted logging.
- **Findings/evidence integrity**: `verified` hardcoded false; engine-only → `INCONCLUSIVE`;
  retest binds baseline+retest manifests, exact revisions or URL checksums, complete
  deterministic coverage, completed terminal receipts — anything less stays `INCONCLUSIVE`,
  never `VALIDATED`/`FIXED`; evidence encrypted via `uploadEvidence`; `storageUri` never
  serialized to API responses (test-asserted); output parser bounds every field, count, and
  traversal depth.
- **Fix-PR pipeline**: proposal route accepts only `workspaceId` + summary metadata; all
  patch/branch/base content resolved server-side; diff validated at generation AND execution;
  forbidden paths (`.github/`, `.git/`, lockfiles, binaries, deletions, new files,
  secret-like additions) rejected; exact diff checksum bound into approval; execution
  verifies hash + expiry + single-executor; default-branch SHA must equal scan `baseCommit`;
  branch + PR only — no merge path exists.
- **Worker lifecycle/cleanup**: startup + periodic reconciliation under distributed lease;
  artifact-deletion outbox drain; bounded loop-closure sweep; stale-resource reaper consults
  DB active-scan ownership, skips running containers, fixed roots/validated IDs only;
  evidence finalized before monetary settlement; partial/failed results preserved honestly.
- **Ops/deployment**: `run-worker.sh` fails closed on missing/ambiguous config; both images
  digest-pinned; provenance from immutable image digest + labels; egress pin syntax
  validated; restrictive dir perms; `docker-compose.yml` dev-only with localhost bindings —
  not a production path.

## v16 overlap statement

No finding overlaps a v16 commit. NV#1 sits adjacent to v16 `79700836`/`bb8ea8bb` (fix-PR
loop closure) but in different files — noted as interaction, not suppressed.

