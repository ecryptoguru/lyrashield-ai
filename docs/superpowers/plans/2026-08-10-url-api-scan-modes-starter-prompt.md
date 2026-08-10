# Starter Prompt: URL and API Scan Modes

You are implementing the approved LyraShield AI URL/API scan-mode redesign in the existing repository.

## Objective

Replace the current cosmetic URL depth selection with an evidence-bounded scanner whose modes perform genuinely different work:

- Web Safe — **Surface Review**: exact page plus at most 6 same-origin JS/CSS assets, passive GET only.
- Web Standard — **Expanded Surface Review**: bounded same-origin discovery, at most 20 documents at depth 2 and 30 assets, passive GET only.
- Web Deep — **Behavioral Surface Review**: Standard plus bounded HEAD, OPTIONS, and alternate-Origin checks; no state-changing requests.
- API Safe — **Endpoint Review**: one exact public endpoint.
- API Standard — **Contract Review**: stored OpenAPI URL required; static review plus at most 10 parameter-free unauthenticated GET/HEAD operations.
- API Deep — **Contract Behavior Review**: OpenAPI required; at most 25 safe GET/HEAD/OPTIONS operations using only documented example/default/enum parameter values, plus controlled behavior comparison.

Safe is the only exposed URL/API mode until each later mode passes its implementation and release gates. `QUICK` remains a hidden URL/API alias for Safe; `CUSTOM` is rejected for URL/API targets. Repository scan behavior must not change.

## Read first

Work from `/Users/defiankit/Desktop/lyrashieldai` and read these files completely before editing:

1. `AGENTS.md`
2. `docs/superpowers/specs/2026-08-10-url-api-scan-modes-design.md`
3. `docs/superpowers/plans/2026-08-10-url-api-scan-modes-implementation.md`
4. `docs/plans/2026-08-10-vibe-security-50-integrity-audit.md`

The design is the product/security contract. The implementation plan is the executable task order. If current code contradicts either document, inspect callers and tests, then make the smallest compatible correction and record the deviation in your handoff.

## Workspace rules

- Expected branch: `codex/vibe-50-integrity-repair`.
- The working tree already contains a material Vibe Security 50 integrity repair. Preserve it. Never use reset, checkout, clean, or broad file replacement.
- Start with Task 0. Review and verify the existing diff before adding URL/API work.
- Do not stage the design/implementation-plan documents in the Task 0 baseline commit.
- Use `rg`/`rg --files` to trace callers before modifying shared functions.
- Implement the plan task-by-task in order. Check off completed steps in the plan.
- Use test-first development for each non-trivial behavior and run the focused verification before committing that task.
- Keep commits focused and use the commit messages in the plan unless the actual diff requires a more accurate message.
- Do not push, deploy, run a paid provider scan, or mutate production.

## Non-negotiable security boundaries

- Never call the external engine for `WEB_APP` or `API` targets.
- Every outbound URL and every redirect hop must pass the existing DNS-aware SSRF checks immediately before the request.
- Only GET, HEAD, and OPTIONS may reach the URL/API fetch boundary. There must be no runtime path for POST, PUT, PATCH, DELETE, CONNECT, or TRACE.
- Do not submit forms, authenticate, replay cookies, send authorization values, guess credentials, fuzz paths, brute-force parameters, or execute exploit payloads.
- Keep discovery on the final seed origin. Strip credentials, query strings, and fragments before deduplication, requests, evidence, or logs.
- Raw response bodies and redirect histories stay in worker memory. Never persist them or matched secret values.
- Limits, failed requests, authentication requirements, missing parameter values, unsupported schemas, and unattempted operations must produce limitations/inconclusive coverage—not broad `NO_FINDING` claims.
- If a mode is not implemented and tested, keep it unavailable in both UI and API.

## Execution sequence

Follow Tasks 0–12 in `docs/superpowers/plans/2026-08-10-url-api-scan-modes-implementation.md` exactly:

1. Verify and checkpoint the current Vibe 50 integrity repair.
2. Add the versioned target-aware capability registry with only Safe URL profiles released.
3. Extract one SSRF-safe collector shared by Lite Check and authenticated scans.
4. Consolidate public-surface analysis and its positive/negative/near-miss corpus.
5. Ship the one honest authenticated Safe mode and remove URL model-budget behavior.
6. Add and release Standard web discovery.
7. Add and release Deep web behavior probes through the narrowly typed safe-fetch controls.
8. Add the API OpenAPI URL setting and migration, including disabling legacy URL Standard/Deep schedules.
9. Add and release API Contract and Contract Behavior modes.
10. Persist only aggregate execution scope and render exact limitations.
11. Enforce target/mode parity across manual scans, v1/MCP calls, schedules, schedule execution, and retests; finish accessible responsive UX.
12. Reconcile public/operator claims with the released behavior.
13. Run the full local verification and rendered QA.

Do not compress these into one large rewrite. Reuse the existing safe-fetch, SSRF, egress, scan admission, evidence, report, and preset boundaries.

## Required handoff after each task

Report:

- task completed and commit SHA;
- files changed;
- focused commands run and their exact result;
- release-state change, if any;
- remaining limitation or risk;
- any plan deviation and why it was necessary.

Stop and ask only if implementation requires credentials, a paid scan, production access, deployment authorization, or a product/security choice not resolved by the design. Otherwise continue through the next safe local task.

## Completion condition

Do not claim completion until all acceptance criteria in the implementation plan pass, the full local gates are green, and the actual dashboard has been inspected at desktop and 390 px mobile widths. Keep production explicitly unverified until a separately authorized deployment and smoke test occur.
