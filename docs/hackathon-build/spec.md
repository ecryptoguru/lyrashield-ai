# Technical Spec

## Overview

Implement WebMCP Assurance as an extension of existing LyraShield product paths. A shared normalized tool-surface model and policy evaluator are the authority. Source adapters discover imperative and declarative WebMCP definitions; product adapters consume the normalized result in the browser, worker, CLI, Action, and report generator. Dashboard WebMCP tools are a separate page-integration layer that calls existing same-origin APIs and updates existing UI state.

No new authorization channel, queue, report type, evidence store, or general agent runtime is introduced.

## Stack

- Shared analysis: TypeScript in `@lyrashield/security`.
- Imperative source parsing: TypeScript compiler API for JS/TS/JSX/TSX and extracted Astro script blocks.
- Declarative source parsing: `parse5` for HTML/Astro template form annotations.
- Browser analysis: a small browser-safe normalized model/policy/rewrite core plus a parser bundle loaded in a dedicated Web Worker only after the user starts a check; no server upload and no parser code in general marketing or dashboard bundles.
- Web application: existing Next.js 16, React 19, Zod 4, and same-origin API helpers.
- Public lab: existing Astro 7 marketing application and ToolLayout patterns.
- Repository execution: existing worker AI App Security source collection and orchestrator.
- CLI/SARIF: existing `lyrashield` CLI diff/gate/SARIF implementation.
- CI: existing composite Action and drift tests.
- Reports: existing immutable `Report.contentJson` snapshots and HTML generator.
- Browser protocol: native WebMCP imperative and declarative APIs with progressive feature detection. Use the official `webmcp-types` package for compile-time types; keep the runtime adapter thin and local so protocol drift stays isolated.

Dependencies added only where justified:

- `typescript` as a runtime parser dependency of `@lyrashield/security` at the repository-pinned version.
- `parse5` as a direct runtime dependency of `@lyrashield/security` for bounded declarative markup parsing.
- `webmcp-types` as a type-only development dependency for browser surfaces; do not maintain a duplicate ambient API declaration.

Package exports must keep the heavy source-discovery adapters out of browser and dashboard imports. The public lab imports them only from its lazy Worker entry. Add a compressed bundle budget and a test proving ordinary marketing pages and dashboard routes do not include `typescript` or `parse5`.

## Architecture

### A. Shared WebMCP Tool Surface Model

Implements: `prd.md > Epic 1: Tool Surface Inventory`

Define versioned types under `packages/security/src/webmcp/`:

```ts
type WebMcpDefinitionKind = "imperative" | "declarative"
type WebMcpBehavior = "read" | "ui-only" | "mutation" | "unknown"
type WebMcpEvidenceState = "DETECTED" | "NO_FINDING" | "INCONCLUSIVE" | "NOT_ASSESSED"

interface WebMcpToolSurface {
  kind: WebMcpDefinitionKind
  name: string | null
  title: string | null
  description: string | null
  inputSchema: NormalizedSchemaSummary
  annotations: {
    readOnlyHint: boolean | null
    untrustedContentHint: boolean | null
  }
  exposedTo: string[] | "dynamic" | null
  behavior: WebMcpBehavior
  networkMethods: string[]
  returnsExternalContent: boolean | null
  forwardsCancellation: boolean | null
  hasRegistrationCleanup: boolean | null
  runtimeValidation: "present" | "absent" | "unknown"
  source: { path: string; startLine: number; endLine: number }
  definitionHash: string
}
```

The definition hash is SHA-256 over canonical, sorted, normalized definition metadata. It excludes raw source, secrets, workspace identifiers, and environment-specific values. Browser and Node adapters share the canonical serializer; Node uses `node:crypto`, browser uses `crypto.subtle`.

### B. Source Discovery Adapters

Implements: `prd.md > Epic 1`, `Epic 5`

`discoverWebMcpTools(files, limits, signal)` performs bounded discovery:

- TypeScript AST visitor recognizes direct `document.modelContext.registerTool` calls, registration options, `execute` bodies, annotations, fetch methods, return expressions, and AbortSignal use.
- Astro files are split into frontmatter/script/template regions with original line offsets retained; executable regions use the TypeScript adapter and template regions use the markup adapter.
- `parse5` recognizes declarative `form[toolname][tooldescription]`, parameters, `toolautosubmit`, submit handlers, and cross-origin `iframe[allow~=tools]`.
- Config/header source recognizes `Permissions-Policy` and `Origin-Agent-Cluster` declarations in the repository's supported configuration files.
- Dynamic values remain `unknown`/`dynamic`; the adapter never evaluates source code.
- Limits: reuse AI App Security file selection, 1 MiB per file, mode-specific file count, total byte limit, maximum 500 tool definitions, and existing wall-time/cancellation behavior.

### C. Policy Engine

Implements: `prd.md > Epic 2`

`evaluateWebMcpSurface(inventory, context)` implements detector version `webmcp-assurance/2` with 14 controls:

1. `WEBMCP-01` Annotation/behavior mismatch.
2. `WEBMCP-02` Externally influenced output lacks `untrustedContentHint`.
3. `WEBMCP-03` Unsafe or dynamic cross-origin tool exposure.
4. `WEBMCP-04` Explicitly unsafe tool permissions or disabled origin isolation. `tools=*`, untrusted delegated origins, `Origin-Agent-Cluster: ?0`, or `document.domain` use can be findings. Missing `Permissions-Policy: tools=(self)` is informational hardening because the platform default is `self`; missing `Origin-Agent-Cluster: ?1` is not a vulnerability when isolation is otherwise intact.
5. `WEBMCP-05` Durable/resource-consuming mutation lacks a visible confirmation boundary.
6. `WEBMCP-06` Sensitive or unbounded input/output contract.
7. `WEBMCP-07` Network operation does not forward cancellation.
8. `WEBMCP-08` Component registration lacks lifecycle cleanup.
9. `WEBMCP-09` Weak schema or missing runtime validation at a trust boundary.
10. `WEBMCP-10` Duplicate, overlapping, ambiguous, or misleading tool contract.
11. `WEBMCP-11` Credential or secret embedded in a tool definition.
12. `WEBMCP-12` Prompt-injection surface in a tool contract.
13. `WEBMCP-13` Spec drift or misplaced registration option.
14. `WEBMCP-14` Tool contract exceeds browser guidance.

Each control has a stable title, severity policy, detection predicate, remediation, safe-rewrite capability, and evidence limitations. Protective wording and code examples must not trigger mutation/prompt-injection findings merely because they mention dangerous patterns.

`NO_FINDING` is emitted only where completed deterministic coverage can establish the absence of that syntactic condition. Semantic behavior that cannot be proven remains `INCONCLUSIVE`.

### D. Deterministic Safe Rewrite Engine

Implements: `prd.md > Epic 4`

`planWebMcpRewrite(source, findings)` returns ordered, non-overlapping `TextEdit[]`, addressed control IDs, unresolved control IDs, warnings, and an updated checksum. Supported transformations use AST/source ranges and preserve surrounding formatting:

- Insert or correct annotations.
- Insert bounded schema properties and `additionalProperties: false` when a closed object schema is structurally safe.
- Forward `{ signal }` into recognized `fetch` calls.
- Add `AbortController` registration cleanup patterns to supported React effects/components.
- For a statically located wildcard `exposedTo`, emit a deterministic same-origin patch using `exposedTo: []`. Dynamic or explicit cross-origin requirements remain unresolved guidance; never guess trusted third-party origins.
- For direct mutation handlers, return confirmation-boundary guidance without a patch; never claim an automatic semantic rewrite is safe.
- Add bounded output mapping for recognized array-return patterns.

Rewrites fail closed on dynamic, ambiguous, overlapping, or syntactically invalid ranges. The public page applies edits only in memory. Repository integration creates an existing fix proposal; PR creation remains separately approved.

### E. Public Security Lab

Implements: `prd.md > Epic 3`, `Epic 4`, `Epic 8`

Add a new tool record and page content under the existing marketing tool system:

```text
apps/marketing/src/lib/tools.ts
apps/marketing/src/lib/webmcp-security.ts
apps/marketing/src/components/tools/WebMcpSecurityLab.astro
apps/marketing/src/pages/tools/[slug].astro
apps/marketing/src/tests/webmcp-security-tool.test.ts
apps/marketing/src/tests/webmcp-browser-contract.test.ts
```

The lab uses existing ToolLayout, local file/paste patterns, accessible output, copy controls, and CTA conventions. It lazy-loads the analyzer after interaction to protect general marketing performance.

WebMCP registrations are deliberately limited to two non-overlapping tools:

- `analyze_webmcp_source`: read-only; analyzes current local input, returns a bounded summary, and updates inventory/findings UI.
- `prepare_webmcp_rewrite`: read-only with respect to external state; prepares a visible diff for currently selected supported findings.

Applying a rewrite, exporting JSON/Markdown/SARIF, loading a sample, and inspecting `getTools()` remain explicit human UI actions. `getTools()` is capability-detected diagnostics only, not a product dependency or a recursively exposed agent tool. The page marks agent-prepared state, shows addressed and unresolved controls, offers Apply and Undo, and reruns the checker after application.

Inputs and outputs stay within Chrome's recommended character budgets where practical. The human UI remains fully usable without WebMCP.

### F. Dashboard WebMCP Runtime

Implements: `prd.md > Epic 7`, `Epic 8`

Add:

```text
apps/web/src/lib/webmcp/register.ts
apps/web/src/lib/webmcp/output.ts
apps/web/src/lib/webmcp/receipts.ts
apps/web/src/components/webmcp/webmcp-receipt-provider.tsx
apps/web/src/components/webmcp/webmcp-activity-drawer.tsx
```

The native registration helper, typed by `webmcp-types`:

- Feature-detects `document.modelContext`.
- Accepts a tool definition and page-owned handler.
- Enforces local name/description/output budgets in development and tests.
- Registers with an `AbortController` and unregisters on cleanup.
- Forwards execution cancellation to API helpers.
- Wraps success, error, and cancellation in bounded structured output.
- Emits a session receipt without persisting source or finding contents.
- Rejects duplicate active names.

Dashboard layout mounts one receipt provider. Each page exposes one focused task tool:

```text
launch readiness: review_launch_readiness
findings: review_findings
scans: prepare_security_scan
```

`review_launch_readiness` returns the bounded summary and can focus the visible blockers. `review_findings` accepts bounded filter fields plus an optional currently visible finding ID, updates filters, and can explain that selection. Combining each page's read operations prevents ambiguous tool selection.

Handlers call existing state transitions and same-origin API helpers. `workspaceId` is captured from authenticated server props, never included in the agent schema. Scan target selection accepts the unique visible target name; duplicates or stale values return a visible validation error and require human selection. Goal/mode are constrained to options already enabled by the page.

Use the declarative API for `prepare_security_scan` when the existing form can be annotated without changing its validation contract: omit `toolautosubmit`, surface `toolactivated`, and keep the existing Start button as the only browser path that creates the scan. If React integration proves incompatible in the supported browser, use the same imperative state-preparation handler as a tested fallback. Neither path invokes `apiPost`.

### G. Human Confirmation And Receipts

Implements: `prd.md > Epic 8`

Receipt type:

```ts
interface WebMcpActivityReceipt {
  id: string
  toolName: string
  classification: "read" | "ui-only" | "mutation-prepared"
  status: "running" | "completed" | "cancelled" | "failed"
  dataClass: "public" | "workspace-summary" | "untrusted-finding" | "source-local"
  untrustedContent: boolean
  uiChanged: boolean
  durableMutation: false
  humanConfirmationRequired: boolean
  startedAt: string
  endedAt?: string
  summary: string
}
```

Show a compact persistent Agent activity chip with the latest status and an expandable, mobile-safe panel containing the last 20 current-tab receipts. Running updates use one polite live region; completed history does not repeatedly announce. UI-only filter/editor changes provide Undo where state can be restored safely. Clear receipts on sign-out and full reload. Approved durable mutations continue to create authoritative audit records through existing APIs; no second audit table is added.

### H. Worker And Evidence Integration

Implements: `prd.md > Epic 5`

Extend `scanAiAppSecurity()` to run the WebMCP analyzer over the already collected source files. Return:

- WebMCP normalized findings.
- Tool inventory summary.
- `WebMcpCoverageReceipt`.
- Inventory checksum and detector version.

The scanner orchestrator keeps the existing AI App Security execution slot and adds WebMCP findings to that family with an explicit `scannerSource`/category. This avoids another repository walk and queue phase.

Extend `ResultManifestInput` and the AI App Security family metadata with the bounded WebMCP receipt. Because the immutable manifest contract changes, bump the result manifest version from 5 to 6 and scanner contract date. Existing v5 reads remain supported.

The receipt includes only bounded metadata, not raw source or full schemas:

```ts
interface WebMcpCoverageReceipt {
  version: "webmcp-assurance/1"
  detectorVersion: string
  eligibleFiles: number
  scannedFiles: number
  toolDefinitionsFound: number
  toolDefinitionsAssessed: number
  incompleteDefinitions: number
  imperativeDefinitions: number
  declarativeDefinitions: number
  limitsReached: string[]
  inventoryChecksum: string
}
```

### I. CLI, SARIF, And GitHub Action

Implements: `prd.md > Epic 6`

Add `@lyrashield/security` as a bundled workspace dependency of the CLI. Extend diff analysis to read the complete changed eligible file content rather than only concatenated added lines for WebMCP structural analysis. Filter returned findings to definitions or source ranges changed by the selected diff.

Commands:

- `lyrashield check-diff` automatically includes WebMCP findings.
- `lyrashield gate --fail-on HIGH` applies the existing threshold.
- Optional focused `lyrashield webmcp check [paths...] --sarif file` is added only if it materially improves developer ergonomics after the automatic integration is complete.

CLI SARIF includes control ID, severity/level, message, file, line, help URI, detector version, and advisory/coverage wording. The self-contained Action subset emits file-level SARIF and remains a fast lexical guard, not a replacement for the CLI's structural result.

The root composite Action remains self-contained and uses the existing guarded-mirror pattern for a documented high-confidence lexical subset. Full structural analysis is authoritative in the CLI, repository scan, and public lab. The Action must never imply 10-control parity: it reports subset coverage and points to `lyrashield check-diff` for complete local analysis. Drift tests compare the common rule IDs, severities, and representative fixtures. No network call, install step, or production credential is required.

### J. Report Integration

Implements: `prd.md > Epic 9`

Extend `ReportData` version from 2 to 3 with optional `webMcpAssurance`. No Prisma migration is required because snapshots use `contentJson`.

The report generator reads the exact scan result manifest and WebMCP findings. It freezes:

- Detector and receipt version.
- Inventory checksum.
- Tool counts by imperative/declarative and read/ui-only/mutation/unknown.
- Exposure and confirmation posture.
- Coverage and limits.
- Findings by control and severity.
- Bounded representative remediation.
- Methodology and claims limitations.

HTML adds a WebMCP Tool Surface section before general finding details. Developer, executive, and compliance variants control detail without creating a new report type. Shared report parsing exposes aggregates only; it excludes source locations, snippets, definition metadata, repository coordinates, and evidence URIs.

Legacy v2 snapshots continue to render without the optional section.

### K. Headers And Browser Enablement

Implements: `prd.md > Epic 3`, `Epic 7`, `Epic 10`

Update both app and marketing responses with explicit defense-in-depth defaults:

```http
Origin-Agent-Cluster: ?1
Permissions-Policy: tools=(self), ...existing directives...
```

Do not add `exposedTo`, `allow="tools"` on cross-origin frames, or wildcard policies. Treat these explicit headers as LyraShield hardening, not proof that every site lacking them is vulnerable. Extend existing header tests and verify live readback after deployment.

### L. Evaluation And Observability

Implements: `prd.md > Epic 10`

Add deterministic contract tests plus a prompt evaluation corpus:

```text
docs/hackathon-build/evals/webmcp-prompts.json
docs/hackathon-build/evals/README.md
```

Prompt cases test correct tool selection, non-selection, invalid parameters, injected finding content, cancellation, stale workspace/page, unsupported browser, mutation requests, and output limits. Record client/browser, exact SHA, prompt, expected tool, observed tool, result, UI effect, and receipt.

Use the official WebMCP inspector for schema/manual execution and ChatGPT's in-app browser for end-to-end agent behavior. Browser automation verifies human-visible states where supported; tool-selection quality remains a recorded evaluation rather than a brittle unit assertion.

Telemetry uses existing analytics only for aggregate events such as feature availability, tool name, status, and duration bucket. Never send source, tool inputs, finding content, inventory, schemas, workspace IDs, or receipts to analytics.

### M. Public Discovery, SEO, AEO, And GEO

Implement one clean information architecture:

- `/tools` adds a featured WebMCP Security group above the general tool list.
- `/tools/webmcp-security-checker` is the single canonical interactive product. Tabs or progressive sections cover Check, Inventory, Rewrite, Export, and CI setup; do not create five thin tools or duplicate URLs.
- `/webmcp` is the canonical pillar page for the plain-language definition, risks, LyraShield approach, versioned 10-control catalog, benchmark summary, implementation guidance, limitations, and links to the checker, CLI/Action docs, methodology, signup, and pricing.
- Existing documentation hosts one implementation guide with copyable CLI and GitHub Action setup. Publish additional pages only when they answer a distinct question with substantial original evidence.

Render useful text, control summaries, limitations, and FAQs in the initial HTML. Reuse existing `SeoHead`, `ToolLayout`, indexability gates, sitemap, breadcrumbs, `WebApplication`/`TechArticle`/`FAQPage` structured data, Open Graph, robots policy, `llms.txt`, and `agents.md` patterns. Add a public versioned JSON control registry generated from the same control metadata; HTML, reports, SARIF help URLs, and machine-readable output must not drift.

The pillar page may register one read-only `explain_webmcp_assurance` tool scoped to an enum of published topics. It returns bounded public text from the same content registry and never exposes unpublished claims, analytics, user data, or dynamic model output. The interactive checker retains its two-tool limit.

Measure Core Web Vitals, initial HTML completeness, keyboard/mobile behavior, internal-link integrity, canonical/OG live readback, sitemap membership, and query-free error reporting. Describe WebMCP as agent-readable interaction that may improve answer quality and qualified conversion, never as direct ranking, indexing, or citation proof.

### N. Judge Access

The primary judging URL is the public Security Lab and requires no login. It must load a safe/unsafe sample, expose working WebMCP tools, and complete the analyze-to-rewrite-to-rerun path without account creation, network source upload, or paid service.

For authenticated dashboard testing, provision a dedicated account through the normal production registration and workspace-membership flow. Assign the existing `DEVELOPER` role, which supports scan, finding, fix, retest, report, and agent workflows without billing or workspace-governance authority. Do not run `packages/db/prisma/seed.ts` in production and do not add a judge-only authentication or authorization branch. The isolated workspace contains only synthetic authorized fixtures and precomputed evidence needed to inspect reports. Apply normal API validation, rate limits, approval boundaries, and audit behavior; deny all platform-admin access.

Store credentials only in Devpost's private testing instructions or an approved secret manager, never Git, planning documents, video, screenshots, analytics, or chat transcripts. Rotate immediately before final verification, verify both supported judge clients, monitor only privacy-safe availability/error signals, keep access working through the stated judging period, then revoke the account and credentials through the normal account lifecycle.

## File Structure

```text
packages/security/src/webmcp/
  types.ts                 normalized contracts and versions
  canonicalize.ts          stable definition serialization
  discover.ts              bounded orchestration
  discover-imperative.ts   TypeScript AST adapter
  discover-declarative.ts  parse5 adapter
  controls.ts              10 control definitions
  evaluate.ts              deterministic policy engine
  rewrite.ts               safe TextEdit planning/apply
  fixtures/                positive, negative, edge, protective fixtures
  *.test.ts                focused regression tests

apps/worker/src/engine/scanners/ai-app-security.ts
apps/worker/src/engine/scanner-orchestrator.ts
apps/worker/src/engine/result-integrity.ts
  reuse source collection; persist v6 coverage receipt

apps/marketing/src/lib/webmcp-security.ts
apps/marketing/src/components/tools/WebMcpSecurityLab.astro
apps/marketing/src/pages/tools/[slug].astro
apps/marketing/src/tests/webmcp-*.test.ts
  public local lab and WebMCP progressive enhancement

apps/web/src/lib/webmcp/
apps/web/src/components/webmcp/
apps/web/src/app/(dashboard)/dashboard/{launch-readiness,findings,scans}/
  page-scoped registrations and visible activity

packages/cli/src/diff-core.ts
packages/cli/src/commands/{check-diff,gate}.ts
packages/cli/src/__tests__/
action.yml
  changed-file analysis, SARIF, gate, guarded Action parity

packages/db/src/report-generator.ts
packages/db/src/report-service.ts
  v3 optional WebMCP report snapshot and safe shared aggregates

docs/hackathon-build/evals/
docs/webmcp-assurance.md
  evaluation corpus, product/operator documentation, submission evidence

apps/marketing/src/pages/webmcp.astro
apps/marketing/src/pages/tools/index.astro
apps/marketing/src/pages/llms.txt.ts
apps/marketing/src/pages/webmcp-controls.json.ts
  canonical discovery hub, featured tool group, machine-readable registry, SEO/AEO/GEO integration
```

## Data Flow

### Source-to-report lifecycle

1. Source collection selects bounded eligible files once.
2. Discovery adapters normalize WebMCP definitions without executing them.
3. Canonicalization produces per-definition hashes and a bounded inventory checksum.
4. The policy engine produces evidence-state signals and safe rewrite capabilities.
5. The worker converts signals into existing normalized findings and persists them through the existing finding path.
6. Result manifest v6 binds coverage receipt, detector version, inventory checksum, source identity, and worker provenance.
7. Report creation freezes the WebMCP section in `contentJson` version 3.
8. Shared reports expose aggregate posture only.

### Browser-agent lifecycle

1. Authenticated server page resolves session, workspace, permissions, and initial data as today.
2. The client component registers only page-relevant WebMCP tools.
3. A browser agent selects and invokes a tool using its JSON schema.
4. The wrapper creates a running receipt and validates input again in code.
5. Read tools call existing same-origin GET APIs; UI tools invoke existing component callbacks.
6. The output is bounded, marked untrusted when applicable, and the visible UI updates.
7. Scan preparation stops after populating the form. Only the existing human click calls `POST /api/scans`.
8. Navigation/workspace change aborts in-flight work and unregisters stale tools.

## External APIs And Dependencies

- WebMCP overview and browser requirements: https://developer.chrome.com/docs/ai/webmcp
- Imperative API and cancellation: https://developer.chrome.com/docs/ai/webmcp/imperative-api
- Declarative forms and visible submission: https://developer.chrome.com/docs/ai/webmcp/declarative-api
- Tool design practices: https://developer.chrome.com/docs/ai/webmcp/best-practices
- Security annotations, exposure, and output budgets: https://developer.chrome.com/docs/ai/webmcp/secure-tools
- WebMCP draft/explainer: https://github.com/webmachinelearning/webmcp
- SARIF 2.1.0 remains the existing output format.

## AI Usage

- Codex assists with planning, implementation, tests, evaluation prompts, documentation, and submission materials.
- Production detection and safe rewrite version one are deterministic; they do not require a model call.
- Optional model-assisted explanations are explicitly outside version-one acceptance and cannot change evidence state.
- Submission documentation must distinguish Codex-assisted engineering from product runtime behavior.

## Risks And Verification

### Parser false confidence

Risk: dynamic JavaScript cannot always be resolved statically.

Control: normalize unknown values, record incomplete definitions, maintain fixture calibration, and keep semantic absence inconclusive.

### Browser API drift

Risk: WebMCP remains experimental.

Control: isolate official protocol types and the registration wrapper, feature-detect at runtime, avoid framework wrappers, and pin evaluation evidence to client/version/date.

### Authorization bypass

Risk: page tools accidentally accept workspace authority or call mutation APIs.

Control: capture workspace from server props, register page-only tools, test cross-workspace inputs, and prohibit mutation API calls inside preparation handlers.

### Prompt injection through findings/source

Risk: repository content influences the browser agent.

Control: `untrustedContentHint`, strict bounding, no instructions copied from findings, normalized plain outputs, and adversarial fixtures.

### Rewrite corruption

Risk: text edits change semantics or formatting.

Control: supported AST shapes only, non-overlapping range validation, parse-after-rewrite, rerun controls, show diff, and require review.

### Action/shared-rule drift

Risk: browser/worker/CLI/Action disagree.

Control: shared policy engine wherever runtime permits; fixture-based drift tests for any unavoidable self-contained Action mirror.

### Report/privacy expansion

Risk: inventory/source data leaks through shared reports.

Control: immutable private snapshot, explicit safe aggregate parser, regression tests proving withheld fields, and no raw schema/source in public payloads.

### Verification gates

- `pnpm db:generate` before typechecking in a clean worktree.
- Focused security-package unit and calibration tests.
- Worker scanner, orchestrator, manifest v5/v6 compatibility, and finding persistence tests.
- CLI diff, gate, SARIF, and Action drift tests.
- Web and marketing typecheck/lint/tests/build.
- Header and CSP regression tests.
- Browser-local privacy check confirming no source upload.
- Accessibility checks for forms, focus, live regions, drawer, cancellation, and keyboard use.
- ChatGPT in-app browser and Chrome WebMCP inspector evaluation.
- Exact-SHA CI, deployment, runtime health, live header/tool discovery, and visual review.
- Self-scan of the final branch and independent review of High/Critical results.

## Demo And Submission Flow

The submission uses the deployed public Security Lab as the immediate entry point, then shows the authenticated production dashboard and a durable report. The first 15 seconds show an agent calling a real registered analyzer and updating the page. The middle proves safe rewrite and CI parity. The final minute proves human-confirmed dashboard operation and evidence-bound reporting. Repository history and documentation identify all WebMCP work added after August 25.

The demo does not use mocks, fabricated reports, bypassed authentication, production billing changes, or hidden agent-only behavior.
