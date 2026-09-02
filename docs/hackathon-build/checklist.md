# Build Checklist

## Build Preferences

- **Build mode:** Autonomous production implementation.
- **Comprehension checks:** N/A; do not stop for ordinary scoped engineering decisions.
- **Git:** New `codex/webmcp-hackathon` worktree/branch from refreshed `origin/main`; focused commits at green dependency boundaries; never push directly to `main`.
- **Verification:** Yes. Unit, integration, type, lint, build, security, browser, deployment, runtime, and visual gates are distinct.
- **Check-in cadence:** Milestone updates; stop only for a genuine founder gate, secret/login requirement, destructive action outside scope, or a material conflict with existing work.
- **Release strategy:** Two dependency-ordered PRs. PR 1 ships the reusable WebMCP Assurance engine and product outputs. PR 2 ships browser-native WebMCP operation, receipts, final evaluations, and submission proof.
- **Claims:** Detection is not verification. Incomplete coverage remains `INCONCLUSIVE`. WebMCP is not presented as direct AEO/GEO ranking proof.

## Checklist

- [x] **1. Establish an isolated, verified implementation baseline**
      Evidence: worktree `lyrashield-ai-webmcp-hackathon` on `codex/webmcp-hackathon` from `origin/main` at `fa0dca32`; `git worktree list --porcelain`, `git status --short --branch`, `git rev-parse HEAD`, `pnpm install`, and `pnpm db:generate` completed. Planning docs preserved. `packages/security` has initial `webmcp/` contracts and passes `typecheck` and `lint`.
      What to build: Preserve the current scorecard branch and untracked hackathon planning files, refresh `origin`, create a clean worktree and `codex/webmcp-hackathon` branch from current `origin/main`, bring the planning documents into that branch, record the baseline SHA, run `pnpm db:generate`, and execute the strongest practical baseline checks before product edits.
      Acceptance: Existing user work remains untouched; the WebMCP branch starts from a known remote SHA; baseline failures are classified before implementation rather than attributed to new code.
      Verify: `git worktree list --porcelain`, `git status --short --branch`, `git rev-parse HEAD`, `pnpm db:generate`, targeted existing package tests, and `git diff --check`.

- [x] **2. Build the normalized Tool Surface discovery layer**
      Evidence: bounded imperative/declarative/Astro/header discovery, cancellation, stable source-bound SHA-256 definition/inventory hashes, exact JSX/TSX parsing, iterative depth/entry limits, and the 227-test security suite pass. Browser-safe page bundle is about 8.5 KiB compressed; the lazy parser Worker remains about 1.03 MiB compressed, above the original aspirational 250 KiB target but outside the initial page load.
      Spec ref: `spec.md > Architecture > A. Shared WebMCP Tool Surface Model` and `B. Source Discovery Adapters`
      What to build: Add versioned types, canonical serialization, Node/browser hashing adapters, bounded TypeScript AST discovery, declarative parse5 discovery, Astro region mapping, header/config discovery, coverage limits, cancellation, definition hashes, and inventory checksum. Split browser-safe policy/model exports from heavy discovery adapters, use official `webmcp-types`, and add a fixture corpus for imperative, declarative, Astro, dynamic, malformed, duplicate, and bounded cases.
      Acceptance: Eligible definitions produce stable inventory entries with source lines and hashes; dynamic/unsupported definitions remain explicit; no source is executed; limits and cancellation are recorded.
      Verify: Security-package unit tests, deterministic checksum snapshot tests, malformed/limit fixtures, browser-bundle import test, compressed Worker budget, proof ordinary marketing/dashboard bundles exclude parser dependencies, typecheck, lint, and repeated-run equality.

- [x] **3. Implement the 14-control policy engine and safe rewrite planner**
      Evidence: all 14 controls, evidence states, bounded checksums, fail-closed rewrite planning, overlap handling, rerun validation, and focused fixtures are implemented. Automatic rewrite is deliberately limited to statically located wildcard exposure; unsupported semantics remain unresolved.
      What to build: Add versioned control metadata, evidence-state evaluation, severity policy, protective-pattern handling, bounded snippets, limitations, supported `TextEdit` rewrites, conflict detection, parse-after-rewrite checks, before/after diff generation, and rerun validation.
      Acceptance: All 14 controls have positive, negative, inconclusive, and protective fixtures where applicable; supported rewrites clear their addressed signal without hiding unrelated findings; ambiguous rewrites fail closed.
      Verify: Control calibration suite, rewrite golden tests, parse-after-rewrite tests, idempotence tests, property/boundary cases for limits, lint, typecheck, and security review of secret handling.

- [x] **4. Integrate WebMCP Assurance into full repository scans and manifest v6**
      Evidence: AI App Security reuses its bounded source collection, retains WebMCP findings and coverage, records partial/limited coverage, and result manifest v6 binds the receipt. Worker typecheck/lint and 41 focused tests pass with valid test-only environment values.
      Spec ref: `spec.md > Architecture > H. Worker And Evidence Integration`
      What to build: Reuse AI App Security source collection, run discovery/policy without another repository walk, normalize/persist WebMCP findings, attach category/control metadata, produce the bounded coverage receipt, bind detector version and inventory checksum into result manifest v6, and keep v5 readers compatible.
      Acceptance: A repository scan retains WebMCP findings and complete/partial coverage correctly; cancelled/failed/bounded analysis cannot create a clean state; existing queue, cost, egress, evidence, and retest behavior does not regress.
      Verify: Worker scanner/orchestrator tests, finding-persister tests, result-integrity v5/v6 compatibility and checksum tests, run-scan job tests, disposable database integration where required, typecheck, lint, and a controlled repository fixture scan.

- [x] **5. Ship the public WebMCP Security Lab and free local checker**
      Evidence: human flow, preloaded unsafe sample, local analysis, inventory/findings, fail-closed rewrite Apply/Undo/rerun, cancellation, exports, CI snippets, source-free agent summaries, public activity receipt, pillar page, controls JSON, SEO integration, headers, and mobile/desktop browser QA are implemented. The duplicate regex fallback was removed. Fourteen focused tests, marketing typecheck/lint/production build, hosted CI, exact-SHA deployment, and a headed native `document.modelContext` run passed. The live human flow rechecked the review-required rewrite, Apply/Undo, and no mobile horizontal overflow.
      Spec ref: `spec.md > Architecture > E. Public Security Lab`
      What to build: Add the production tool page using existing ToolLayout patterns, file/paste modes, preloaded unsafe example, local inventory, control results, coverage, safe rewrite diff, explicit Apply/Undo, local JSON/Markdown/SARIF export, registered-tool diagnostics, accessible empty/error/cancel states, privacy wording, and exactly two progressive WebMCP tools: analyze source and prepare rewrite. Run the lazy parser in a Worker after interaction. Add a featured WebMCP Security group to `/tools`, one substantial `/webmcp` pillar page, a generated public control registry, and existing sitemap/structured-data/`llms.txt` integration without duplicate thin tool pages.
      Acceptance: The page works fully for humans without WebMCP, works agentically with supported browsers, uploads no source, produces the same control IDs/version as the worker, and exposes useful indexable content before JavaScript runs.
      Verify: Marketing unit tests, browser privacy/network assertion, WebMCP schema/manual execution in the inspector, accessibility/keyboard/focus review, mobile and desktop visual review, canonical/OG/structured-data/sitemap/`llms.txt` checks, internal-link validation, parser-excluded performance budget, `pnpm --filter @lyrashield/marketing typecheck`, lint, test, and build.

- [x] **6. Extend CLI, SARIF, and the GitHub Action regression gate**
      Evidence: CLI complete-file diff analysis, changed-range filtering, location-rich SARIF, threshold gating, guarded Action subset, and drift tests are implemented. CLI typecheck/lint/tests/build and hosted CI passed.
      Spec ref: `spec.md > Architecture > I. CLI, SARIF, And GitHub Action`
      What to build: Bundle the shared analyzer into the CLI, inspect complete changed eligible files while filtering findings to changed definitions/ranges, include WebMCP findings in `check-diff` and `gate`, emit help/version/location-rich SARIF, implement the documented self-contained high-confidence Action subset using the existing guarded mirror, and add drift fixtures.
      Acceptance: CLI and Action use identical rule IDs/severities for their common subset; default High gating blocks only qualifying findings; advisory results remain visible; no hosted credential or network call is required for local checking.
      Verify: CLI command tests, JSON/human output tests, SARIF schema assertions, severity threshold matrix, Action drift tests, a temporary Git repository diff fixture, and a local/CI Action run against unsafe and safe examples.

- [x] **7. Add the immutable WebMCP report section and safe shared aggregates**
      Evidence: report snapshot v3 gathers validated manifest metadata, renders bounded WebMCP coverage/posture/checksum, and shared reports expose allowlisted aggregates only. DB typecheck/lint and report tests pass, including malformed metadata and no-raw-source coverage.
      Spec ref: `spec.md > Architecture > J. Report Integration`
      What to build: Bump report snapshot data to v3, gather the exact manifest receipt and WebMCP findings, render audience-appropriate Tool Surface inventory/coverage/posture/findings/methodology, preserve legacy v2 rendering, and extend shared-report parsing with safe aggregates only.
      Acceptance: Private developer/executive/compliance reports include the expected section; legacy reports render; shared payloads never expose source locations, snippets, schemas, repository coordinates, evidence URIs, or internal infrastructure values.
      Verify: Report data and HTML golden tests, snapshot backward-compatibility tests, shared-report allowlist tests, XSS/escaping fixtures, workspace isolation tests, and generated HTML visual inspection.

- [x] **8. Open PR 1 and pass the reusable-assurance release gates**
      Spec ref: `spec.md > Overview` and `Risks And Verification`
      What to build: Update affected current-truth documentation, public limitations, CLI docs, detector/control version notes, and PR evidence. Commit the shared analyzer, rewrites, worker integration, free lab, CLI/Action, and report output as focused commits; open PR 1 without touching unrelated scorecard work.
      Acceptance: PR 1 has exact files, test evidence, migration statement, rollback plan, claims boundary, and post-merge deployment checks; required CI is green and review findings are resolved without bypass.
      Verify: Repository-wide relevant lint/typecheck/tests/build, `pnpm db:generate`, security scans, formatting, `git diff --check`, clean merge state, and required GitHub checks.

- [~] **9. Build the dashboard WebMCP runtime and visible activity receipts**
  Evidence: lifecycle registration, strict Zod input validation, escaped bounded output, cancellation, duplicate prevention, stable receipt snapshots, async registration failure handling, 20-item session receipts, and keyboard-correct activity drawer are implemented. Web typecheck/lint, 30 focused tests, and production build pass. Native WebMCP inspector execution remains.
  Spec ref: `spec.md > Architecture > F. Dashboard WebMCP Runtime` and `G. Human Confirmation And Receipts`
  What to build: Add official `webmcp-types`, a thin native lifecycle wrapper, structured output/budget enforcement, cancellation, duplicate prevention, a 20-item session receipt store, compact latest-status chip, expandable mobile-safe activity panel, accessible live updates, analytics allowlist, and dashboard-level provider.
  Acceptance: Unsupported browsers retain the complete human UI; registrations clean up on page/workspace change; receipts expose no sensitive inputs and correctly classify read, UI-only, prepared mutation, cancellation, and failure.
  Verify: Hook/wrapper unit tests, Strict Mode mount/unmount tests, duplicate/lifecycle/cancellation tests, receipt ring and redaction tests, accessibility tests, web typecheck and lint.

- [~] **10. Register production page tools and enforce human mutation boundaries**
  Evidence: launch-readiness review, findings filtering/explanation with Undo, and scan-form preparation use authenticated page context; no WebMCP tool starts a scan or performs a durable mutation. App/marketing isolation headers and focused tests pass. Native supported-client and authenticated cross-workspace browser proof remain.
  Spec ref: `spec.md > Architecture > F. Dashboard WebMCP Runtime` and `prd.md > Epic 7`, `Epic 8`
  What to build: Add one combined launch-readiness review tool, one combined findings-review tool, and declarative-first scan preparation to existing components. Capture workspace authority from server props, validate all schemas, mark finding content untrusted, visibly label agent-prepared state, provide safe Undo for UI-only changes, and prove preparation never calls the scan POST path. Add explicit `Origin-Agent-Cluster` and `Permissions-Policy: tools=(self)` hardening headers to app and marketing.
  Acceptance: Agents have full useful access to current page data within the user's existing permissions; cross-workspace attempts fail; scan preparation fills only valid current options and waits for the user's existing Start control; no cross-origin tool exposure exists.
  Verify: Component/API contract tests, cross-workspace and stale-target tests, spies proving no POST during preparation, header/CSP tests, WebMCP inspector calls, ChatGPT in-app browser flows, mobile/desktop visual review, and live header readback after deploy.

- [~] **11. Run the complete evaluation, security, and production deployment loop**
  Evidence: `docs/hackathon-build/evals/README.md`, `webmcp-prompts.json`, and `adversarial-prompts.json` are present. Focused test suites, security diff scans, hosted CI `33229378214`, Azure release `33229692568`, exact-SHA marketing readback, public health/readiness, header/privacy/SEO checks, headed native public-lab tools, and mobile human-flow checks passed. Authenticated dashboard and recording evidence still need a normal isolated user.
  What to build: Add the prompt/evaluation corpus, adversarial finding/source fixtures, unsupported-client and cancellation cases, performance budgets, privacy assertions, search/answer-engine verification, exact-SHA deployment procedure, health checks, and live evidence capture. Open PR 2 for dashboard/runtime/evals/docs; merge only on green.
  Acceptance: Expected prompts choose the correct focused tool; ambiguous or dangerous prompts do not trigger durable actions; outputs remain bounded; source stays local; exact deployed SHA and runtime health are proven separately from CI; every selected feature works live.
  Verify: Security-package calibration, full relevant monorepo checks, marketing/web builds, Playwright/manual browser matrix, WebMCP inspector, ChatGPT in-app browser prompts, production health/readiness, exact revision/digest/traffic evidence, and live no-source-upload observation.

- [~] **12. Prepare and verify the Devpost handoff**
  Evidence: narrative, public links, test steps, screenshot shot list, limitations, and external-gate list are in `devpost-submission.md`. The project is not submitted; video and private judge instructions do not exist yet.
  Spec ref: `prd.md > Submission Proof Points` and `spec.md > Demo And Submission Flow`
  What to build: Document pre-existing versus post-August-25 work, final architecture, control table, privacy and claims limits, public repo/license proof, live URL/test instructions, exact agent clients tested, AI/Codex usage, screenshots, concise project description, and a sub-three-minute demo showing the real production chain. Provision a dedicated ordinary production user with the existing `DEVELOPER` role through normal registration in an isolated synthetic judge workspace; keep credentials only in Devpost private testing instructions, never the repository or video. Keep the project name a founder decision.
  Acceptance: The no-login public lab proves the primary path; authenticated testing uses no privileged role or bypass; every claim is supported by code or exact-SHA live evidence; the video shows a working WebMCP call within 15 seconds; access remains available through judging.
  Verify: Incognito public repository/license and lab test, normal-user judge login in both supported clients, cross-workspace/platform-admin denial, billing-admin denial, quota/approval checks, credential rotation and private placement, video duration/audio/visibility check, Devpost requirement checklist, final exact-SHA smoke, and `$prepare-submission` live validation before any submit confirmation.
