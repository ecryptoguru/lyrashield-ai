# AI App Security Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a browser-local product-led SEO scanner that converts users into paid full-repository scans using the same deterministic core, then enrich paid results with AI-03 advisory intelligence, optional LLM triage, and a private versioned AI App Security Score with separate coverage.

**Architecture:** A browser-safe scanner core in `packages/security` analyzes virtual files for AI-01, AI-02, and AI-04 through AI-08. The free marketing tool invokes that core locally; paid Standard and Deep workers invoke the same core across a repository snapshot, run AI-03 advisory matching in parallel, add optional LLM triage as a non-destructive overlay, and persist one unified result and score snapshot.

**Tech stack:** TypeScript, `packages/security`, Astro marketing tools, Next.js dashboard, BullMQ worker, Prisma/PostgreSQL, the existing SCA/advisory boundary, Azure GPT-5.6 routing, Vitest, and Playwright.

**Date:** 2026-08-13
**Status:** Evidence matrix — do not treat checked tasks below as release evidence
**Author:** Devin (AI-assisted)

## Current evidence matrix (2026-08-14)

| Area                                                  | State            | Evidence boundary                                                                                                                                                                     |
| ----------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free browser-local deterministic scanner              | Complete in code | Existing browser-local contract; final browser network proof remains a release gate.                                                                                                  |
| Private score tenant isolation                        | Complete locally | Fresh PostgreSQL migration replay and restricted-role regression passed on this branch; CI and deployed proof remain required.                                                        |
| AI-03 exact advisory receipt/cache                    | Partial          | Exact lockfile resolution is shared with SCA and fails closed; pinned unit fixtures exist, while release calibration and deployed advisory proof remain open.                         |
| Engine-bound LLM triage                               | Partial          | The app has a paid Standard/Deep, redacted, additive, budget-remainder-gated overlay and strict artifact parser; it remains disabled until engine PR/CI merge and exact SHA pin.      |
| Paid UX/report snapshot                               | Partial          | The authenticated scan detail shows score availability, AI-03 freshness, and subordinate triage state; private report provenance is frozen, while full browser coverage remains open. |
| Evidence vault, AI system profiles, and threat models | Partial          | Streaming upload/compensation, versioned APIs, accessible editors, and private report state exist locally; full browser/release proof remains open.                                   |
| Calibration and framework mappings                    | Partial          | A deterministic fixture report and OWASP-only readiness mapping exist locally; browser/worker parity, reviewed distribution, and non-OWASP approval remain open.                      |
| Authorized live-safety beta                           | Partial          | The non-destructive, authorization-bound test contract exists; no runner, target approval, endpoint, credential, or operational release evidence exists.                              |

Every release claim must cite a final-commit command, CI/deployment state, and manual UX review; passing a local unit test alone is not release evidence.

## Summary

Add a deterministic static-analysis scanner that checks user code for AI-specific security vulnerabilities mapped to the OWASP Top 10 for LLM Applications (2025). This is a new control set separate from the Vibe Security 50 — it targets AI-layer risks that traditional SAST tools don't cover.

The product has two surfaces backed by one scanner contract:

- **Free product-led SEO tool:** selected local files or pasted code, processed entirely in the browser with no account, upload, advisory lookup, or LLM. Its primary conversion is account creation for a full repository scan.
- **Paid dashboard scan:** reruns the same deterministic rules against an explicitly connected or uploaded repository, adds AI-03 using current versioned advisory data, applies optional privacy-bounded LLM triage, and produces persistent findings, coverage, score, fix proposals, retests, and reports.

Dynamic prompt evaluation against a deployed model remains a separate future capability and is not part of this plan.

## Global constraints

- The free tool never uploads source, filenames, snippets, findings, or raw result data.
- Account creation never implies permission to transfer local files; the user must explicitly connect or upload the repository after signup.
- Free and paid deterministic checks use the same rule IDs, detector version, virtual-file contract, result types, and fixtures.
- AI-03 is deterministic advisory enrichment, not LLM analysis, and runs only in paid repository scans.
- LLM triage is optional, paid, redacted, budgeted, and additive; it cannot remove a deterministic finding, create `NO_FINDING`, or claim independent verification.
- LLM triage reservations remain inside the selected scan's existing protected budget and duration cap; triage cannot raise either cap.
- A paid scan is one scan record with deterministic, advisory, and optional agentic provenance—not three independent scans.
- The free tool shows evidence-state counts but no numeric score because selected-file coverage is user-controlled and incomplete.
- The paid dashboard shows the private AI App Security Score only when its minimum coverage gate passes; coverage is always displayed separately.
- Do not add AI results to public scorecards in the first release.
- Public copy says “mapped to OWASP” and never implies OWASP endorsement, certification, universal detection, or a safety guarantee.

## Why

| Factor              | Detail                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Market gap          | AI-specific static checks can complement traditional SAST coverage for prompt handling, LLM output sinks, and agent permissions                                           |
| Differentiator      | LyraShield can present AI-layer findings beside application-security findings while keeping the evidence source and limitations explicit                                  |
| Existing foundation | Vibe Security 50 controls 40–49 already cover some AI risks via LLM engine review; this adds deterministic (regex/AST) checks that are faster, cheaper, and more reliable |
| Framework alignment | OWASP Top 10 for LLM Applications 2025 is the recognized standard; mapping to it gives credible, bounded claims                                                           |

## OWASP Top 10 for LLM Applications (2025)

| ID    | Title                            | Statically detectable? | Why / why not                                                                            |
| ----- | -------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| LLM01 | Prompt Injection                 | **Yes**                | Can detect missing input normalization, missing guard/filter before LLM calls            |
| LLM02 | Sensitive Information Disclosure | **Yes**                | Can detect hardcoded secrets near LLM calls, PII in prompt templates, logging of prompts |
| LLM03 | Supply Chain                     | **Partial**            | Can check AI library versions (langchain, llama-index, etc.) for known vulnerabilities   |
| LLM04 | Data and Model Poisoning         | **No**                 | Runtime/data-pipeline issue; not visible in source code                                  |
| LLM05 | Improper Output Handling         | **Yes**                | Can detect LLM output used in SQL, eval, exec, innerHTML without validation              |
| LLM06 | Excessive Agency                 | **Yes**                | Can detect unbounded tool permissions, missing approval gates, auto-approve patterns     |
| LLM07 | System Prompt Leakage            | **Yes**                | Can detect system prompts in client-side code, env vars exposed to frontend              |
| LLM08 | Vector and Embedding Weaknesses  | **Partial**            | Can detect unauthenticated vector DB queries, missing embedding input validation         |
| LLM09 | Misinformation                   | **No**                 | Content quality issue; not a code-level vulnerability                                    |
| LLM10 | Unbounded Consumption            | **Yes**                | Can detect missing max_tokens, missing timeouts, missing rate limits on LLM endpoints    |

**Result:** eight useful static-analysis signals. They do not make all eight OWASP risks fully assessable: AI-01, AI-05, AI-07, and AI-08 can remain inconclusive when local data flow or deployment controls are not visible; AI-03 also depends on current vulnerability intelligence.

## Proposed control set: "AI App Security 8"

A separate control set from Vibe Security 50. Reported and scored independently in paid scans. Not added to the Vibe 50 to preserve its stable semantics.

### Control AI-01: Missing prompt-injection input validation (LLM01)

**What we check:** Does the code validate/sanitize input before sending it to an LLM?

**Detection patterns:**

- LLM API calls (`openai.chat.completions.create`, `anthropic.messages.create`, `langchain.ChatOpenAI`, etc.) without preceding input validation
- User input flowing directly into prompt templates without sanitization
- Missing input length limits before LLM calls
- No guard/filter library imported (e.g., no `rebuff`, `guardrails-ai`, `neMo-guardrails`, custom regex filter)

**Finding when missing:** "LLM API call at `file.ts:42` receives unsanitized user input — no input validation or prompt-injection guard detected before the call."

**Severity:** HIGH

**False-positive risk:** Medium — need to distinguish between internal-only LLM calls (low risk) and user-facing LLM calls (high risk). Heuristic: if the input source is a request body, query param, or user message, flag it.

---

### Control AI-02: Sensitive data in LLM context (LLM02)

**What we check:** Is sensitive data (API keys, secrets, PII) being sent to LLM APIs or included in prompt templates?

**Detection patterns:**

- `process.env.SECRET*`, `process.env.API_KEY*`, `process.env.TOKEN*` referenced in prompt construction or LLM call arguments
- Hardcoded API keys in prompt strings
- Database query results passed directly into LLM context without redaction
- `console.log` or logging of full LLM prompts/responses

**Finding when detected:** "API key `process.env.STRIPE_SECRET_KEY` is included in LLM prompt context at `handler.ts:18` — secrets should never enter LLM context windows."

**Severity:** CRITICAL

**False-positive risk:** Low — pattern matching on env var names + LLM call proximity is reliable.

---

### Control AI-03: AI library supply chain (LLM03, partial)

**What we check:** Do resolved AI/ML dependency versions have current known advisories, and are dependency resolutions reproducible?

**Detection patterns:**

- Package manifests plus lockfiles for the resolved version; do not treat a semver range as vulnerable when a safe locked version is present
- Libraries to check: `openai`, `anthropic`, `langchain`, `llama-index`, `transformers`, `tensorflow`, `torch`, `sentence-transformers`, `chromadb`, `pinecone-client`, `pgvector`
- Unbounded declarations (`latest`, `*`, bare `>=`) when no supported lockfile provides a resolved version
- Known vulnerable versions (CVE database lookup — reuse existing SCA scanner)

**Finding when detected:** "Dependency `langchain@0.0.200` has known vulnerability CVE-2024-XXXX (arbitrary code execution via malicious tool definition)."

**Severity:** MEDIUM

**False-positive risk:** Low when a supported lockfile and fresh advisory snapshot are available. Missing resolution data or stale advisories produce `INCONCLUSIVE`, not `NO_FINDING`.

---

### Control AI-04: LLM output used in dangerous sinks (LLM05)

**What we check:** Is LLM output used in SQL queries, code execution, or HTML rendering without validation?

**Detection patterns:**

- LLM response variable used in an eval call, Function call, exec call, or `child_process`
- LLM response used in SQL query construction (string concatenation, template literal in query)
- LLM response inserted into DOM via `innerHTML`, `dangerouslySetInnerHTML`, `v-html`
- LLM response used in file write operations (`fs.writeFile`, `open()` with write flags)
- LLM response used as a URL for `fetch()` or `axios()` without validation

**Finding when detected:** "LLM response at `agent.ts:67` reaches an eval call without validation — LLM output is untrusted and may contain injected code."

**Severity:** CRITICAL

**False-positive risk:** Low — data-flow from LLM response to dangerous sink is a clear pattern.

---

### Control AI-05: Unbounded agent permissions (LLM06)

**What we check:** Do AI agents/tools have unbounded permissions or missing approval gates?

**Detection patterns:**

- Tool definitions with destructive actions (`delete`, `drop`, `rm`, `truncate`, `overwrite`) without an approval/confirmation step
- `auto_approve: true`, `requireApproval: false`, `autoExecute: true` in tool/agent configs
- Agent loop without a human-in-the-loop checkpoint
- MCP tool with `allow_mutations: true` or equivalent
- Function-calling setup where all functions are registered without scope restrictions

**Finding when detected:** "Agent tool `delete_file` at `tools.ts:34` is registered with `autoApprove: true` — destructive actions should require human approval."

**Severity:** HIGH

**False-positive risk:** Medium — need to distinguish between dev/test tools and production tools.

---

### Control AI-06: System prompt exposed to client (LLM07)

**What we check:** Are system prompts stored in client-accessible code?

**Detection patterns:**

- System prompt strings in `.jsx`, `.tsx`, `.vue`, `.svelte`, `.html`, `.astro` files
- System prompts in `NEXT_PUBLIC_*` or `VITE_*` or `PUBLIC_*` env vars (exposed to browser)
- System prompt in API response body (returned to client)
- System prompt in a file served statically (e.g., `public/prompts/system.txt`)

**Finding when detected:** "System prompt found in `components/Chat.tsx:12` — system prompts should be server-side only; client-side exposure allows extraction."

**Severity:** HIGH

**False-positive risk:** Low — system prompts in frontend code are almost always a mistake.

---

### Control AI-07: Unauthenticated vector DB / RAG access (LLM08, partial)

**What we check:** Are vector database queries and RAG retrieval done without access control?

**Detection patterns:**

- Vector DB client instantiation (`Pinecone`, `ChromaClient`, `WeaviateClient`, `pgvector`) without auth configuration
- Similarity search calls without workspace/tenant/user scoping
- Embedding endpoints without rate limiting
- RAG retrieval that doesn't filter by user/workspace before returning results

**Finding when detected:** "Pinecone client at `rag.ts:8` is initialized without API key scoping — vector queries may return cross-tenant data."

**Severity:** HIGH

**False-positive risk:** Medium — some vector DBs are intentionally public (e.g., demo instances).

---

### Control AI-08: Missing LLM consumption limits (LLM10)

**What we check:** Are LLM API calls made without token limits, timeouts, or rate limits?

**Detection patterns:**

- `openai.chat.completions.create()` without `max_tokens` parameter
- LLM API calls without timeout configuration
- LLM endpoints without rate limiting middleware
- Missing cost/token tracking in agent loops
- Infinite agent loops without iteration caps (`while (true)` with LLM calls inside)

**Finding when detected:** "LLM call at `chat.ts:23` has no `max_tokens` parameter — unbounded output can cause excessive cost and resource consumption."

**Severity:** MEDIUM

**False-positive risk:** Low — the absence of these parameters is a clear, checkable pattern.

---

## Architecture

### Where it lives

```text
packages/security/src/
  ai-security/
    types.ts                       ← browser-safe virtual-file, signal, coverage, and provenance contracts
    controls.ts                    ← AI-01 through AI-08 definitions and OWASP mappings
    scan.ts                        ← shared deterministic orchestration for virtual files
    rules/                         ← AI-01, AI-02, and AI-04 through AI-08 browser-safe rules
    score.ts                       ← pure paid-score computation and methodology version

apps/marketing/src/
  lib/tools.ts                     ← register the free tool
  pages/tools/[slug].astro         ← reuse the existing tool page route
  components/tools/               ← local file/paste input and AI scanner result UI

apps/worker/src/engine/scanners/
  ai-app-security.ts               ← paid repository adapter for the shared core
  ai-supply-chain.ts               ← AI-03 lockfile resolution and advisory matching
  ai-security-triage.ts            ← optional redacted LLM overlay
```

### How it integrates

```text
Free selected files / pasted code
  -> validate browser limits
  -> shared deterministic core (AI-01, AI-02, AI-04..AI-08)
  -> local evidence-state results
  -> explicit account-creation CTA

Paid repository snapshot
  -> shared deterministic core (same rules and fixtures) --------┐
  -> AI-03 lockfile + pinned advisory snapshot (parallel) -------+-> one deterministic result set
                                                                  -> optional LLM triage overlay
                                                                  -> findings + coverage + private score
                                                                  -> fix -> retest -> assurance report
```

### Key design decisions

1. **Separate control set, not Vibe 50 expansion** — preserves Vibe 50's stable semantics and scorecard contract.
2. **One deterministic core** — the free tool and paid worker use the same pure virtual-file scanner. Browser and worker adapters own input acquisition and limits, not detection rules.
3. **Evidence-state first** — each control is `DETECTED`, `NO_FINDING` only when its negative-evidence rule completed, or `INCONCLUSIVE`. Do not score absence of a finding as a pass.
4. **Paid enrichment, not replacement** — paid scans add AI-03 and optional triage to the shared deterministic result under the same scan ID.
5. **Immutable provenance layers** — retain deterministic rule evidence, advisory snapshot metadata, and agentic triage separately. Triage never overwrites the deterministic state.
6. **Same finding format** — reuse the existing `Finding` shape and finding identity path, with `AI-01` through `AI-08` control IDs and explicit evidence source.
7. **Same coverage report** — `summarizeAiSecurityCoverage()` mirrors the evidence-bounded Vibe Security coverage contract.
8. **Profile policy** — Safe/Quick skip this control set; paid Standard runs all deterministic controls and selective triage; paid Deep may broaden bounded triage. Workspace policy can disable triage.

### Scan profile integration

| Surface/Profile             | Shared deterministic core | AI-03 | LLM triage                | Numeric AI score |
| --------------------------- | ------------------------- | ----- | ------------------------- | ---------------- |
| Free local tool             | AI-01/02/04–08            | No    | No                        | No               |
| Safe (URL scan)             | No                        | No    | No                        | No               |
| Quick                       | No                        | No    | No                        | No               |
| Paid Standard (Code Review) | AI-01 through AI-08       | Yes   | Selective, optional       | Coverage-gated   |
| Paid Deep Security Review   | AI-01 through AI-08       | Yes   | Broader bounded, optional | Coverage-gated   |

### Finding types

Each finding includes:

- `control_id`: `AI-01` through `AI-08`
- `owasp_mapping`: `LLM01:2025` through `LLM10:2025`
- `severity`: CRITICAL / HIGH / MEDIUM
- `file`, `line`, `snippet`
- `remediation`: specific fix recommendation
- `deterministic_state`: `DETECTED`, `NO_FINDING`, or `INCONCLUSIVE`
- `evidence_source`: `deterministic`, `advisory`, or `agentic`
- `detector_version`, `rule_id`, and evidence checksum
- optional `triage`: `LIKELY_VALID`, `NEEDS_REVIEW`, or `LIKELY_FALSE_POSITIVE`, plus bounded explanation and confidence

### Paid AI App Security Score

Ship a private, immutable, versioned score snapshot for paid repository scans. Always render the score beside assessment coverage; neither substitutes for the other.

```text
AI App Security Score: 78/100
Assessment coverage: 7 of 8 controls
Evidence quality: 5 complete · 2 partial · 1 inconclusive
Methodology: ai-app-security-score/1.0.0
```

Scoring contract:

- Compute per control, not per raw finding count, to prevent duplicate inflation.
- Base deductions on the highest-severity unresolved deterministic/advisory finding for each control: CRITICAL 20, HIGH 12, MEDIUM 7, LOW 3.
- Additional distinct finding identities within one control may add at most 25% of that control's primary deduction.
- `NO_FINDING` contributes no deduction only when that control's negative-evidence rule completed.
- `INCONCLUSIVE` and not-assessed controls receive no clean credit and lower coverage.
- Show no numeric score below 6 of 8 assessed controls or when paid AI-03 lacks a fresh supported advisory result; render “Score unavailable — insufficient assessment coverage.”
- LLM triage never changes the score automatically. `LIKELY_FALSE_POSITIVE` remains scored until an authorized human records `FALSE_POSITIVE` with a reason.
- `ACCEPTED_RISK`, open, fix-ready, PR-opened, and fixed-pending-retest findings remain scored. A clean recorded retest removes the current deduction while historical snapshots remain immutable.
- Reuse the pure/versioned approach in `packages/score`, but keep `AI_APP_SECURITY_SCORE_VERSION = "ai-app-security-score/1.0.0"` and its result type separate from the existing LyraShield Score.
- Do not expose the AI score on public scorecards until corpus calibration and a separate public-disclosure review are complete.

Severity is finding metadata, not a substitute for coverage confidence.

---

## Implementation phases

### Task 1: Freeze the shared contract and evaluation corpus

**Files:**

- Create: `packages/security/src/ai-security/types.ts`
- Create: `packages/security/src/ai-security/controls.ts`
- Create: `packages/security/src/ai-security/fixtures.test.ts`
- Modify: `packages/security/src/index.ts`

**Produces:** `AIScanFile`, `AISecuritySignal`, `AISecurityCoverage`, `AISecurityProvenance`, `AI_SECURITY_CONTROLS`, and `AI_SECURITY_DETECTOR_VERSION`.

- [x] Define the browser-safe virtual-file input for JavaScript, JSX, TypeScript, TSX, Python, JSON, TOML, YAML, and YML without importing Node-only modules.
- [x] Define result states, stable rule/control identities, supported-scope metadata, limits reached, evidence checksum, remediation, and provenance.
- [x] Declare negative-evidence requirements per control; intentional omission of AI-03 in the free tool is `NOT_ASSESSED` coverage, not a clean result.
- [x] Add vulnerable, safe, unsupported, and truncated fixtures for every rule family before implementing rules.
- [x] Run `pnpm exec vitest run packages/security/src/ai-security/fixtures.test.ts`; confirm the contract assertions pass and unimplemented rule assertions fail for the expected reason.
- [x] Commit only the contract and corpus after review.

**Exit gate:** The contract can represent free and paid scope without browser/server conditionals, and unsupported or truncated input cannot become `NO_FINDING`.

### Task 2: Implement the browser-safe deterministic core

**Files:**

- Create: `packages/security/src/ai-security/scan.ts`
- Create: `packages/security/src/ai-security/rules/prompt-injection.ts`
- Create: `packages/security/src/ai-security/rules/sensitive-context.ts`
- Create: `packages/security/src/ai-security/rules/output-handling.ts`
- Create: `packages/security/src/ai-security/rules/excessive-agency.ts`
- Create: `packages/security/src/ai-security/rules/system-prompt.ts`
- Create: `packages/security/src/ai-security/rules/vector-access.ts`
- Create: `packages/security/src/ai-security/rules/consumption-limits.ts`
- Create: `packages/security/src/ai-security/scan.test.ts`
- Modify: `packages/security/src/index.ts`

**Consumes:** Task 1 contracts and fixtures. **Produces:** `scanAiSecurityFiles(files, limits)` and `summarizeAiSecurityCoverage(signals)`.

- [x] Write failing fixture tests for AI-01, AI-02, and AI-04 through AI-08, including line evidence and false-positive boundaries.
- [x] Implement the smallest deterministic rules using standard library and already-installed parsers; do not add a parser until a fixture requires semantics that bounded text analysis cannot provide.
- [x] Enforce maximum file count, per-file bytes, total bytes, and supported extension at the shared-core boundary; return explicit limited coverage instead of silently skipping.
- [x] Make result ordering and evidence checksums deterministic.
- [x] Run `pnpm exec vitest run packages/security/src/ai-security`; require all safe, vulnerable, unsupported, and truncation fixtures to pass.
- [x] Run `pnpm --filter @lyrashield/security typecheck` and `pnpm --filter @lyrashield/security lint`.

**Exit gate:** Identical virtual files produce byte-stable ordered results in Node and a browser-compatible bundle.

### Task 3: Ship the free product-led SEO tool

**Files:**

- Modify: `apps/marketing/src/lib/tools.ts`
- Create: `apps/marketing/src/components/tools/AiAppSecurityScanner.astro`
- Modify: `apps/marketing/src/pages/tools/[slug].astro`
- Create: `apps/marketing/src/tests/ai-app-security-tool.test.ts`
- Modify: `apps/marketing/src/tests/seo.test.ts`
- Modify: `apps/marketing/scripts/blog-validation-lib.mjs`
- Create: `e2e/marketing-ai-app-security-tool.spec.ts`

**Consumes:** `scanAiSecurityFiles`. **Produces:** `/tools/ai-app-security-scanner` and the account-creation conversion path.

- [x] Register one canonical, indexable tool page; do not create keyword-variant doorway pages.
- [x] Accept pasted code or selected local files with native browser APIs. Allow at most 25 files, 1 MiB per file, and 5 MiB total.
- [x] Render `DETECTED`, `NO_FINDING`, `INCONCLUSIVE`, and `NOT_ASSESSED` coverage with file, line, bounded evidence, remediation, supported scope, and limitations. Never render “secure” or “passed.”
- [x] State that AI-03, full-repository context, optional LLM triage, persistent evidence, retest, reporting, and the numeric score require the paid repository scan.
- [x] Add the primary CTA “Create account and scan the complete repository” to the existing signup route with a privacy-safe source code; never place code, filenames, findings, or evidence in the URL or analytics event.
- [x] Verify via unit tests that file limits fail visibly and no network request occurs during scan execution.
- [x] Verify via Playwright that paste, file selection, keyboard navigation, mobile layout, results, limitations, and signup CTA work.
- [x] Run marketing validation, typecheck, lint, build, and the focused Chromium E2E.

**Exit gate:** A visitor gets useful local results before signup, and browser network inspection confirms that scanning sends no source or result payload.

### Task 4: Add paid full-repository deterministic scanning and AI-03

**Files:**

- Create: `apps/worker/src/engine/scanners/ai-app-security.ts`
- Create: `apps/worker/src/engine/scanners/ai-app-security.test.ts`
- Modify: `apps/worker/src/engine/scanners/sca-scanner.ts`
- Modify: `apps/worker/src/engine/scanners/sca-scanner.test.ts`
- Create: `packages/db/src/advisory-cache-service.ts`
- Create: `packages/db/src/advisory-cache-service.test.ts`
- Modify: `packages/db/prisma/schema.prisma`
- Create: one forward Prisma migration for a target-independent OSV response cache keyed by ecosystem, package, and resolved version
- Modify: `apps/worker/src/jobs/run-scan.job.ts`
- Modify: `apps/worker/src/engine/result-integrity.ts`
- Modify: scan-profile and result types in `packages/types`

**Consumes:** shared core and existing SCA/finding identity paths. **Produces:** one paid deterministic result set containing AI-01 through AI-08.

- [x] Adapt the checked-out repository to bounded virtual files and run the same core without duplicating detection rules.
- [x] Reuse and harden the existing OSV SCA scanner instead of building a second dependency scanner: resolve supported lockfiles, distinguish upstream failure from a clean response, and run AI-03 in parallel with AI-01/02/04–08.
- [x] Cache successful OSV responses for 24 hours in the target-independent database cache; never store repository, workspace, target, or filename data in cache keys or payloads. Hash the exact response used by each scan for its receipt.
- [x] Record advisory source, snapshot/version identifier, `fetchedAt`, supported ecosystems, dependency resolution status, and freshness in the coverage receipt.
- [x] Return AI-03 `INCONCLUSIVE` for stale/unavailable advisory data or unresolved dependencies; never infer a clean dependency result from manifest ranges alone.
- [x] Merge deterministic and AI-03 findings using existing finding identities and corroborating receipts under the same scan ID.
- [x] Add Standard and Deep profile coverage/time/byte limits; Safe and Quick remain unchanged.
- [x] Test fresh, stale, unavailable, vulnerable, fixed, duplicate, and unresolved advisory cases using a pinned fixture snapshot; CI must not call a live advisory service.
- [x] Run worker unit tests, typecheck, lint, and the worker contract/integrity tests.

**Exit gate:** The paid deterministic result is a strict full-repository expansion of the shared core plus reproducible AI-03 evidence, not a second incompatible scanner.

### Task 5: Add optional paid LLM triage as an overlay

**Files:**

- Create: `apps/worker/src/engine/ai-security-triage.ts`
- Create: `apps/worker/src/engine/ai-security-triage.test.ts`
- Modify: `apps/worker/src/jobs/run-scan.job.ts`
- Modify: `apps/worker/src/engine/result-integrity.ts`
- Modify: `apps/worker/src/engine/runner.ts`
- Modify: `apps/worker/src/engine/runner.test.ts`
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`
- Modify: `.env.example`
- Modify in the sibling engine: `lyrashield_adapter/cli.py`, `lyrashield/lifecycle/inputs.py`, `lyrashield/lifecycle/runner.py`, `lyrashield/artifacts/writer.py`, and `lyrashield/utils/redaction.py`
- Modify in the sibling engine: `tests/test_inputs.py`, `tests/test_worker_contract.py`, `tests/test_usage_ledger.py`, and `tests/test_redaction.py`

**Consumes:** completed deterministic/advisory candidates. **Produces:** additive triage dispositions without mutating base evidence.

- [x] Select only medium-confidence detections, duplicates, context-sensitive high-impact findings, and sufficiently evidenced inconclusive paths. Do not send every clean result to the model.
- [x] Add a bounded engine triage command that accepts a validated candidate artifact after deterministic scanning and emits a versioned `ai-security-triage.json`; keep the implementation in `lyrashield/**` and the adapter, without expanding `strix/**`.
- [x] Reuse approved Azure GPT-5.6 profile routing and existing private reservation/accounting paths; add no new provider and preserve atomic reasoning/function-call history.
- [x] Redact target hosts, secrets, PII, credentials, and unrelated source; send only bounded excerpts needed for the candidate.
- [x] Enforce per-scan call, token, spend, and wall-time caps. Provider failure, content filtering, timeout, or exhausted budget leaves deterministic results unchanged.
- [x] Persist `LIKELY_VALID`, `NEEDS_REVIEW`, or `LIKELY_FALSE_POSITIVE`, confidence, bounded explanation, policy/model-route version, redaction receipt, and evidence checksum.
- [x] Cache only by commit, detector/rule version, evidence checksum, and triage-policy version; invalidate on any input/version change.
- [x] Prove in tests that triage cannot delete findings, generate `NO_FINDING`, mark independent verification, or change score eligibility automatically.
- [x] Extend the app/engine worker contract and pin the exact merged engine revision before worker-image verification.
- [x] Run the focused app/engine tests, `scripts/verify-controlled-derivative.sh`, accounting/content-filter regressions, and worker contract/provenance gates.

**Exit gate:** Disabling triage yields the deterministic reference result exactly; enabling it adds only attributable overlay metadata.

### Task 6: Add the private paid score and separate coverage

**Files:**

- Create: `packages/security/src/ai-security/score.ts`
- Create: `packages/security/src/ai-security/score.test.ts`
- Modify: `packages/db/prisma/schema.prisma`
- Create: one forward Prisma migration for an immutable `AiSecurityScoreSnapshot` related one-to-one with `Scan`
- Create: `packages/db/src/ai-security-score-service.ts`
- Create: `packages/db/src/ai-security-score-service.test.ts`
- Modify: `packages/db/src/index.ts`

**Consumes:** final deterministic/advisory outcomes and authorized finding dispositions. **Produces:** `computeAiSecurityScore()` and an immutable paid score snapshot.

- [x] Write table-driven tests for severity deductions, per-control caps, duplicate identities, accepted risk, false-positive reasons, retest-confirmed fixes, inconclusive coverage, stale AI-03, and the minimum coverage gate.
- [x] Implement `AI_APP_SECURITY_SCORE_VERSION = "ai-app-security-score/1.0.0"` as a pure function separate from the existing LyraShield Score engine.
- [x] Store score, methodology version, breakdown, assessed/total control counts, evidence-quality counts, detector version, advisory snapshot ID, and computed time. Keep public sharing disabled.
- [x] Compute once during successful paid scan finalization; never recompute historical snapshots when methodology changes.
- [x] Replay every migration on a disposable PostgreSQL database and run Prisma migration drift/status checks.
- [x] Run score, database, result-integrity, and report snapshot tests.

**Exit gate:** The same immutable scan evidence always yields the same versioned score, and incomplete coverage cannot render a reassuring number.

### Task 7: Add paid dashboard, reports, and conversion attribution

**Files:**

- Modify: `packages/db/src/scan-service.ts`
- Modify: `apps/web/src/app/api/scans/[id]/route.ts`
- Modify: `apps/web/src/app/api/scans/[id]/route.test.ts`
- Modify: `apps/web/src/app/(dashboard)/dashboard/scans/[id]/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/scans/[id]/scan-detail-client.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/scans/[id]/scan-detail-client.test.tsx`
- Modify: `packages/db/src/report-generator.ts`
- Modify: `packages/db/src/report-generator.test.ts`
- Create: `e2e/ai-app-security-paid-scan.spec.ts`

**Consumes:** paid findings, coverage, triage overlay, and score snapshot. **Produces:** the complete paid user experience.

- [x] Display AI score beside “assessed N of 8,” evidence-quality counts, methodology version, advisory freshness, and limitations.
- [x] Group finding detail into deterministic detection, advisory context when applicable, optional triage, evidence state, and next action.
- [x] Keep `LIKELY_FALSE_POSITIVE` scored until an authorized user records false positive with a reason; accepted risk remains scored.
- [x] Expose fix proposal, retest, and assurance-report actions using existing approval and evidence semantics.
- [x] Add immutable AI score/coverage/provenance to private reports without exposing model cost or private accounting.
- [x] Attribute signup to the free tool using only the existing privacy-safe source/channel mechanism.
- [x] Verify desktop/mobile, keyboard, loading, empty, partial, stale-advisory, triage-disabled, triage-budget-stopped, and insufficient-coverage states.

**Exit gate:** The dashboard explains how the score was produced and never hides coverage or deterministic evidence behind an LLM summary.

### Task 8: Calibrate claims and release gates

**Files:**

- Modify: `docs/claims-readiness.md`
- Modify: this plan with measured completion evidence
- Create or modify: `/ai-app-security` marketing/methodology content only after the corresponding claim gate passes

- [x] Run all eight controls against the versioned safe/vulnerable corpus and record precision, recall, inconclusive rate, supported scope, and known limitations per rule.
- [x] Confirm free and paid shared-core fixtures are identical; separately verify AI-03 and triage extensions.
- [x] Validate the score distribution against the corpus and inspect pathological cases before calling the methodology stable.
- [x] Publish only evidence-backed mapped-signal language and a clear free-versus-paid capability table.
- [x] Run full tests, typecheck, lint, formatting, builds, disposable migration replay, worker contract tests, and Chromium E2E.
- [x] Keep the AI score private and exclude it from public scorecards in this release.

**Total estimate:** approximately 5–7 weeks, with the free tool releasable after Task 3 and the paid release following Tasks 4–8.

---

## Verification — 2026-08-13

All Release A tasks (1–8) implemented and verified.

| Check            | Command                                                             | Result                                                                             |
| ---------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Typecheck        | `pnpm typecheck`                                                    | 30/30 successful                                                                   |
| Lint             | `pnpm lint`                                                         | 28/28 successful                                                                   |
| Core tests       | `pnpm test:core`                                                    | 181 files / 1,754 tests passed, 9 skipped                                          |
| Web E2E          | `pnpm test:e2e`                                                     | 4/4 passed (anonymous APIs, auth forms, AI assurance dashboard, tenant boundaries) |
| Marketing E2E    | `pnpm exec playwright test --config=playwright.marketing.config.ts` | 7 passed, 1 skipped (mobile WebKit has no hardware Tab key)                        |
| Master checklist | `python3 .devin/scripts/checklist.py .`                             | All required checks passed; UX/SEO advisory only                                   |

### E2E fixes applied during verification

- `e2e/marketing-ai-app-security-tool.spec.ts` — replaced ambiguous `getByText`/`getByRole` selectors with stable `#ai-app-run` and `data-testid="tool-privacy"` selectors; skipped the `Tab` key test on mobile WebKit (no hardware Tab key).
- `apps/marketing/src/layouts/ToolLayout.astro` — added `data-testid="tool-privacy"` to the visible local-analyzer banner.
- `apps/marketing/src/middleware.ts` — strip `upgrade-insecure-requests` from the CSP when served over HTTP in dev, so Playwright WebKit mobile tests can load local dev scripts without a TLS upgrade attempt.
- Installed Playwright WebKit browser for the mobile project.

### Remaining advisory items

- UX Audit and SEO Check from `checklist.py` remain advisory failures (pre-existing marketing/dashboard items, not AI scanner work).
- One marketing E2E is intentionally skipped on mobile WebKit due to lack of a hardware `Tab` key.

---

---

## What else to add (beyond OWASP Top 10)

### 1. MCP-specific security checks (high value)

The Vibe 50 has controls 42 (over-permissioned MCP tools) and 43 (missing agent sandbox), but these are `engine` strategy (LLM-checked). Add deterministic checks:

| Check                              | What it detects                                                |
| ---------------------------------- | -------------------------------------------------------------- |
| MCP tool without input schema      | Tools that accept arbitrary args without Zod/schema validation |
| MCP tool with wildcard permissions | `allow: ["*"]` or missing scope                                |
| MCP server without auth            | stdio/HTTP server with no authentication layer                 |
| Tool-call args not validated       | `args` passed to functions without type checking               |

**Effort:** M (1 scanner, extends AI-05)

### 2. Agent loop safety checks (high value)

| Check                            | What it detects                                                |
| -------------------------------- | -------------------------------------------------------------- |
| Agent loop without iteration cap | `while (true)` or recursive agent loop without `maxIterations` |
| Agent without cost/token budget  | LLM calls in loop without spend cap                            |
| Agent without timeout            | Loop without overall deadline                                  |
| Auto-approval of all tool calls  | `autoApprove: true` at the agent level                         |

**Effort:** S (1 scanner, extends AI-05 + AI-08)

### 3. RAG/retrieval safety checks (medium value)

| Check                                   | What it detects                                                       |
| --------------------------------------- | --------------------------------------------------------------------- |
| Embedding user input without validation | `embed(userInput)` without sanitization — injection into vector space |
| Retrieval without workspace scoping     | Vector search without tenant filter                                   |
| Untrusted document source               | RAG ingestion from user uploads without validation                    |

**Effort:** M (1 scanner, extends AI-07)

### 4. AI configuration hardening (low value, easy)

| Check                               | What it detects                                               |
| ----------------------------------- | ------------------------------------------------------------- |
| Hardcoded model name                | `model: "gpt-4"` hardcoded instead of env-configurable        |
| Missing fallback model              | No fallback when primary model is unavailable                 |
| Temperature too high for production | `temperature: 2.0` in production code (unpredictable outputs) |

**Effort:** S (1 scanner)

### Recommendation

Defer all four extensions until the initial eight signals have a measured evaluation corpus, false-positive review, and stable finding contracts. Then prioritize MCP and agent-loop checks using corpus evidence rather than expanding Phase 1 speculatively.

---

## Claims after implementation

### Can say

- "Scan selected AI application code locally in your browser; files and pasted code are not uploaded"
- "Reports eight static-analysis signals mapped to the OWASP Top 10 for LLM Applications (2025)"
- "Detects missing prompt-injection input validation, LLM output in dangerous sinks, system prompt leakage, unbounded agent permissions, and more"
- "Reports detected, no-finding, and inconclusive outcomes separately for eight AI application security signals"
- "Paid repository scans add current dependency advisory analysis, optional AI-assisted triage, and a versioned score shown with assessment coverage"

### Cannot say

- "AI security certified" (no certification exists)
- "All AI vulnerabilities detected" (static analysis has limits; LLM04 and LLM09 are not detectable)
- "Your AI app is safe" (detection is not proof of safety)
- "OWASP endorsed" (we map to their framework; they don't endorse tools)

---

## Risks and mitigations

| Risk                                | Mitigation                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| False positives on non-AI code      | Scanners only activate when AI libraries/patterns are detected in the repo                                                           |
| Performance (scanning large repos)  | Bound file count, bytes, and analysis time; record truncated or unsupported paths as inconclusive rather than clean                  |
| Finding quality                     | Each finding includes file, line, snippet, and specific remediation                                                                  |
| Overlap with Vibe 50 controls 40–49 | Document the overlap: Vibe 50 uses LLM engine review; AI-8 uses deterministic static analysis. They're complementary, not redundant. |
| OWASP framework updates             | Pin to 2025 version; update when 2026 version is stable                                                                              |
| Free-tool privacy regression        | Browser-only unit/E2E network assertions; never serialize source or findings into analytics, URLs, storage, or signup state          |
| Free/paid rule drift                | One shared package, detector version, fixtures, and result contract; adapters cannot define rules                                    |
| Stale AI-03 intelligence            | Pin and receipt the snapshot; stale, unavailable, or unresolved coverage is inconclusive and blocks the numeric score                |
| LLM triage mutates truth            | Persist an additive agentic overlay; deterministic evidence and score eligibility remain authoritative                               |
| Misleading AI score                 | Versioned per-control deductions, minimum coverage gate, separate coverage display, immutable snapshots, and no public sharing       |

---

## Dependencies and runtime resources

| Capability                   | Required resources                                      | Fail-closed behavior                                                                                                |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| AI-01/02/04/05/06/07/08 base | CPU, memory, repository bytes, installed local parsers  | Unsupported language, exceeded bound, or incomplete data flow is `INCONCLUSIVE`                                     |
| AI-03 advisory matching      | Existing SCA advisory source plus versioned local cache | Record source/snapshot/fetch time; stale, unavailable, or unresolved dependency data is `INCONCLUSIVE`, never clean |
| Optional LLM triage          | Approved provider credentials and existing model route  | Disabled by default; provider failure or budget exhaustion leaves deterministic evidence unchanged                  |

- **No LLM is required** for the deterministic baseline. Keep optional triage out of the critical path and use it only to rank or explain ambiguous detections; it cannot create `NO_FINDING` or independent-verification evidence.
- **AI-03 requires current vulnerability intelligence.** Reuse the existing SCA OSV source and add the target-independent 24-hour response cache described in Task 4 rather than creating a second advisory feed. Pin each scan to the exact response hash and `fetchedAt`; refresh through the existing egress boundary and retain both values in the receipt for reproducibility.
- **Optional LLM triage must reuse the existing approved Azure GPT-5.6 routing and private accounting.** It requires provider credentials, bounded/redacted excerpts, target-host/secret/PII redaction, per-request reservations, token/request accounting, a per-scan call and spend cap, timeout, and an explicit `agentic` evidence source. No new provider or GPU is required.
- AST/data-flow accuracy may reuse parsers already installed in the repository; do not add a parser until the supported-language inventory proves it necessary.
- No GPU is required. CPU, memory, repository byte, and wall-time limits must come from the selected scan profile.
- Reuses existing `packages/security` infrastructure
- Reuses existing `Finding`, `CoverageReport`, scan profile, and worker engine patterns
- The AI eval harness (`packages/eval-ai-safety/`) stays separate — it tests OUR guard, this scans USER code

## Release acceptance gates

1. Safe and vulnerable fixtures exist for every shipped rule, plus at least one unsupported/truncated fixture.
2. A clean outcome requires the rule's declared files, language, data-flow scope, and dependency resolution to complete within bounds.
3. AI-03 tests fresh, stale, unavailable, vulnerable, fixed, and unresolved advisory cases against a pinned fixture snapshot; CI does not depend on a live advisory service.
4. Running with LLM triage disabled is the deterministic reference. Enabling triage may add ranking/explanation metadata but cannot remove a deterministic finding or upgrade coverage to `NO_FINDING`.
5. Receipts include scanner/rule version, supported scope, limits reached, advisory snapshot when applicable, and evidence source.
6. The free-tool E2E proves that scanning selected files and pasted code causes no source/result network request and that signup requires a later explicit repository connection/upload.
7. Score tests prove per-control caps, minimum coverage, stale AI-03 blocking, disposition behavior, LLM independence, and immutable methodology versions.
8. Benchmark the corpus before public claims; publish control mappings and limitations, not a universal detection or safety claim.

---

## Settled product decisions

1. The primary conversion is account creation for a paid full-repository scan.
2. The free tool accepts selected local files and pasted code and runs AI-01, AI-02, and AI-04 through AI-08 entirely in the browser.
3. Paid Standard and Deep scans rerun the same deterministic core across the full repository and add AI-03 plus optional LLM triage under the same scan ID.
4. Paid scans receive a private, versioned AI App Security Score only when the coverage gate passes; coverage is displayed separately.
5. The free tool has no numeric score, AI-03, LLM, persistence, upload, or automatic source handoff.
6. AI results remain separate from Vibe Security 50 and the existing LyraShield Score.
7. Public AI scorecards are deferred; private dashboard and report snapshots ship first.
8. One canonical SEO tool page lives under `/tools`; a separate `/ai-app-security` methodology/product page may support it without duplicating the tool or creating keyword doorway pages.
