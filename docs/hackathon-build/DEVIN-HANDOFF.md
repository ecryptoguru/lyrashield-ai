# Devin Desktop IDE Build Prompt

You are the senior implementation owner for LyraShield AI's WebMCP Assurance production build and WebMCP Challenge entry.

Repository: `/Users/defiankit/Desktop/lyrashield-ai`

First fetch `origin --prune`, inspect all worktrees and branches, and preserve every existing user change. The current checkout contains unrelated scorecard work and untracked hackathon planning documents, so do not implement there. Create an isolated worktree and `codex/webmcp-hackathon` branch from refreshed `origin/main`. Never push directly to `main`.

Read `AGENTS.md`, then read every file in `docs/hackathon-build/` completely. Treat `docs/hackathon-build/checklist.md` as the ordered execution plan, `spec.md` as the implementation contract, `prd.md` and `scope.md` as product acceptance, and `build-notes.md` as the decision record. Also consult root `PRD.md`, `codebase.md`, `product.md`, and `monetization.md` where the checklist touches existing architecture. Running code, schema, tests, CI, and current official WebMCP behavior override stale documentation; record any necessary plan correction before implementing it.

Build every checklist item as a real production feature. Work autonomously through implementation, tests, debugging, accessibility, responsive UX, DX, security, performance, SEO/AEO/GEO, CLI/CI, reports, browser behavior, and documentation. Reuse existing LyraShield APIs, auth, tenancy, validation, rate limits, approvals, audit, queue, evidence, report, CLI, Action, marketing, and UI patterns. Keep changes focused and avoid unrelated refactors, duplicate systems, thin SEO pages, demo-only paths, or weakened controls.

Use subagents aggressively for maximum safe parallelism. You remain the lead integrator and own architecture, shared contracts, dependency ordering, conflict resolution, final verification, and PR quality. Do not create agent soup: every subagent needs a bounded scope, exclusive file ownership, acceptance criteria, required tests, and a written handoff. Use separate branches/worktrees when agents can write concurrently; never let two agents edit the same files. Read-only reviewers may inspect any area but must report findings to the owning agent instead of patching overlapping code.

Establish the baseline and shared normalized contracts first, then fan out work that can proceed independently. Recommended ownership:

1. **Core analyzer agent:** `packages/security/src/webmcp/**`; normalized inventory, discovery adapters, canonical hashing, 14 controls, rewrites, fixtures, and package exports.
2. **Worker and report agent:** worker scanner/orchestrator/manifest integration plus report snapshot/rendering and compatibility tests. Consume the frozen core contracts; do not redefine them.
3. **Public product agent:** Security Lab, lazy Worker integration, Free Tools section, `/webmcp` pillar, control registry endpoint, SEO/AEO/GEO, accessibility, responsiveness, and marketing tests.
4. **Dashboard WebMCP agent:** native registration adapter, page tools, declarative-first scan preparation, human confirmation, activity receipts, Undo, headers, and web tests.
5. **CLI and CI agent:** complete CLI analysis, human/JSON/SARIF output, diff filtering, thresholds, self-contained Action subset, drift fixtures, and developer documentation.
6. **Evaluation and adversarial QA agent:** read-only-first cross-cutting review of schemas, prompt selection, malformed/dynamic/protective fixtures, cancellation, stale/cross-workspace behavior, privacy, accessibility, performance, and claims. Send defects to the owning agent and independently rerun fixes.

The lead must publish contract changes before dependent agents start, maintain a dependency map, and integrate in small green commits. Parallelize tests, browser review, documentation verification, and security review whenever they do not race active writes. If a subagent blocks, reassign only its remaining bounded work; do not duplicate the entire task. Require each subagent to return changed files, exact commands/results, assumptions, limitations, and integration notes before its work can enter a PR.

Preserve these non-negotiable boundaries:

- WebMCP never becomes a new authorization channel. Never accept authority-bearing workspace/user identifiers, API keys, evidence locations, or permissions from an agent.
- Durable or resource-consuming mutations remain behind existing visible human confirmation and server authorization.
- Source used by the free checker stays in the browser and is never uploaded.
- Incomplete or dynamic analysis remains `INCONCLUSIVE`; detection is not verification or certification.
- No automatic model-generated repository changes, guessed trusted origins, wildcard exposure, customer-data access, privileged judge role, authentication bypass, billing admission change, or production seed.
- Do not expose secrets, source, schemas, finding bodies, workspace identifiers, evidence URIs, model costs, or upstream engine identity in logs, analytics, receipts, shared reports, commits, or PR text.
- Do not claim WebMCP directly improves rankings, indexing, citations, or security guarantees.

Use the two dependency-ordered delivery units defined in the checklist. Open review-ready PRs only after their local gates pass, but do not merge, deploy, provision judge credentials, or submit to Devpost. We will perform the independent final review, live test, release decision, and update afterward.

Verification is part of the build. Run `pnpm db:generate` before clean-worktree typechecking, then execute all relevant focused and repository-level unit, integration, lint, typecheck, build, formatting, security, manifest/report compatibility, CLI/SARIF/Action, accessibility, responsive visual, browser privacy, WebMCP lifecycle/cancellation, prompt-evaluation, performance, and SEO/indexability checks required by the checklist. Test safe, unsafe, malformed, dynamic, protective-wording, limit, cancellation, unsupported-browser, stale-workspace, cross-workspace, and mutation-attempt cases. Keep CI, mergeability, deployment, runtime, live browser, and visual proof as separate evidence gates.

Debug failures to their shared root cause. Do not patch around failing tests, weaken assertions, skip security checks, or mark checklist items complete without evidence. If blocked by credentials, browser support, production access, or a founder-only decision, finish everything else and record the exact blocker, attempted checks, owner, and next action.

Maintain concise progress in `docs/hackathon-build/DEVIN-STATUS.md`: current checklist item, lead branch/worktree/HEAD/base SHA, active subagents and ownership, dependency/merge state, changed files, exact commands and results, browser evidence, blockers, PR links, and next action. Update checklist completion and build notes only when evidence supports them.

Return the work in review state with:

- PR links or exact branch and commit stack;
- base and head SHAs;
- changed-file summary;
- exact test/build/evaluation commands and results;
- screenshots or browser-evaluation artifacts;
- security, privacy, migration, compatibility, performance, accessibility, and rollback notes;
- unresolved findings and limitations;
- CI, merge, deploy, live, judge-access, and submission gates still pending.

Do not declare the product production-ready or hackathon-ready. Stop at a clean, evidence-backed handoff for independent final review.
