# Product Requirements Document

## Product Summary

WebMCP Assurance is a production LyraShield capability that gives developers an inventory of the browser-agent tools their application exposes, evaluates those tools against versioned deterministic controls, prepares safe rewrite proposals, prevents high-confidence regressions in pull requests, and preserves results in LyraShield's existing evidence and report lifecycle. LyraShield's own authenticated pages also expose a small set of context-aware WebMCP tools so browser agents can help users interpret results and prepare actions without bypassing permissions or human confirmation.

The product must work as a coherent whole across five surfaces: public local checker, full repository scan, CLI/CI, authenticated dashboard, and durable report. The hackathon demonstration uses the same deployed product and production code paths.

## Target User

### Primary: Web application developer

The developer is adding or reviewing WebMCP tools and wants actionable feedback before exposing them to browser agents. They need fast local feedback, exact source locations, safe examples, and a CI gate that does not overclaim exploitability.

### Secondary: Security or platform reviewer

The reviewer needs an inventory of agent-visible capabilities, exposure and mutation classifications, coverage limits, retained findings, and evidence-bound reports across repositories and releases.

### Existing LyraShield user

The user wants a browser agent to help navigate a complex security workflow. They expect the agent to operate only inside their current workspace and permissions and to leave scans, retests, reports, shares, PRs, and other durable mutations under visible human control.

## Core User Journey

1. A first-time visitor opens the public WebMCP Security Lab and immediately sees a short explanation, a preloaded unsafe example, local-file and paste options, and a privacy statement.
2. They run the deterministic checker manually or ask a WebMCP-capable browser agent to analyze the visible source.
3. The page shows a tool inventory, control-by-control evidence states, exact bounded evidence, remediation, coverage, and limitations. No source leaves the browser.
4. For supported findings, the user requests a safe rewrite. LyraShield shows a deterministic before/after proposal and names which controls it addresses. Nothing is deployed or committed automatically.
5. The developer connects the repository to LyraShield or runs the CLI/Action. The same control IDs and rule versions appear in full scan findings and SARIF.
6. High-confidence findings at the configured threshold block the pull request; advisory findings remain visible without blocking.
7. After a full scan, the user generates an existing LyraShield report containing the frozen WebMCP Tool Surface inventory, policy findings, coverage, and limitations.
8. Inside the dashboard, the user's browser agent can read launch readiness, filter visible findings, explain a selected finding, and prepare a scan form.
9. Before any scan starts, the page visibly requires human confirmation. The activity receipt distinguishes page-only preparation from durable server mutation.

## Epics And User Stories

### Epic 1: Tool Surface Inventory

- As a developer, I want LyraShield to discover every eligible `document.modelContext.registerTool` definition in the assessed source so that I can review the browser-agent surface as an inventory rather than individual snippets.
- As a reviewer, I want each inventory item to include name, description, annotations, schema summary, source location, exposure, apparent behavior, and a stable definition hash so that changes are attributable.
- As a developer, I want incomplete parsing or bounded discovery to be explicit so that absence of inventory is not mistaken for absence of tools.

Acceptance criteria:

- Supported JavaScript, TypeScript, JSX, TSX, Astro, and HTML sources containing eligible imperative or declarative WebMCP definitions produce inventory entries.
- Each entry contains a source location and stable definition hash derived only from normalized public definition metadata, never secret values.
- Duplicate names, dynamic values, unsupported syntax, unreadable files, file limits, byte limits, and time limits are represented in coverage or findings.
- A repository with no eligible definition returns `NOT_ASSESSED` or a documented empty inventory state, not a security pass.

### Epic 2: Deterministic WebMCP Policy Analysis

- As a developer, I want versioned deterministic controls so that local, worker, CLI, and CI results agree.
- As a security reviewer, I want honest evidence states and severity rationale so that policy candidates are not presented as verified exploits.

Acceptance criteria:

- Version one implements 10 controls covering annotation accuracy, untrusted content, exposure, permissions policy, confirmation, sensitive/bounded output, cancellation, lifecycle cleanup, schema/runtime validation, and tool clarity.
- Every signal includes control ID, state, severity, file, line when known, bounded snippet, remediation, evidence source, detector version, and limitations.
- Results use `DETECTED`, `NO_FINDING`, `INCONCLUSIVE`, or `NOT_ASSESSED` consistently.
- The analyzer is deterministic: identical normalized input and detector version produce identical inventory hashes and policy results.
- The shared rule corpus has positive, negative, protective-wording, incomplete-syntax, and limit fixtures.

### Epic 3: Public Local Security Lab

- As a visitor, I want to paste code or select files and analyze them locally so that I can evaluate WebMCP without creating an account or uploading source.
- As a browser-agent user, I want the page to expose focused WebMCP tools so that the agent can analyze source and prepare a rewrite without DOM guessing.
- As a visitor, I want results to remain understandable without an agent so that the page is a complete human product.

Acceptance criteria:

- The public page works without authentication and provides an immediately runnable sample.
- File and paste inputs enforce documented file, byte, extension, and time limits.
- The browser performs analysis locally; network inspection confirms source is not uploaded.
- Registered tools are focused and non-overlapping: analyze current source and prepare a safe rewrite. Apply, Undo, export, sample loading, and registered-tool diagnostics remain clear human UI actions.
- Manual and agent-invoked execution update the same visible result state.
- Agent-prepared changes are visibly labeled, show a diff and limitations, and require the user to Apply; reversible editor and filter changes offer Undo.
- The parser loads in a Worker only after interaction and does not inflate ordinary marketing or dashboard bundles.
- Empty, invalid, unsupported, cancelled, rate-limited, and unavailable-WebMCP states have useful accessible messages.
- The page remains usable in browsers without WebMCP; only the agent enhancement disappears.
- `/tools` features a distinct WebMCP Security group, but code checking, inventory, rewrite, export, and CI setup remain modes of one canonical tool instead of thin duplicate pages.
- A canonical `/webmcp` pillar page explains the problem, controls, methodology, limitations, benchmark, CLI/Action adoption, and paid evidence workflow with server-rendered useful content before JavaScript runs.

### Epic 4: Safe Rewrite Proposals

- As a developer, I want a deterministic rewrite proposal for supported findings so that I can correct common mistakes without trusting an unconstrained generated patch.
- As a reviewer, I want the proposal tied to findings and limitations so that I know what it does and does not fix.

Acceptance criteria:

- Version-one automatic transformation is limited to a statically located wildcard `exposedTo` declaration rewritten to same-origin scope. Annotation, schema, cancellation, cleanup, output, and mutation-semantic findings receive explicit unresolved guidance until a deterministic transform can preserve behavior confidently.
- Each proposal identifies addressed and unaddressed control IDs.
- The public tool applies changes only to the visible editor after the user clicks Apply; the agent can prepare but cannot apply. It never changes a repository.
- Repository rewrite output is a proposal or patch artifact and enters the existing LyraShield approval-bound fix workflow before any PR creation.
- Unsupported or ambiguous syntax returns guidance without producing a misleading patch.
- Re-running the analyzer on a supported rewrite clears the addressed deterministic signal without suppressing unrelated findings.

### Epic 5: Full Repository Scan And Evidence

- As a LyraShield customer, I want WebMCP analysis included in normal repository scans so that it participates in the same evidence, finding, retest, and report lifecycle as other security checks.
- As a reviewer, I want coverage and provenance bound to the scan manifest so that the report reflects the exact assessed revision.

Acceptance criteria:

- Repository scans reuse the shared analyzer; they do not implement a second rule engine.
- Discovery obeys existing source limits, ignored directories, cancellation, symlink, and coverage-recording rules.
- Findings persist through the existing finding persister with workspace and scan identity.
- The coverage receipt records eligible definitions, assessed definitions, incomplete definitions, files, bytes, limits, detector version, and inventory checksum.
- Missing or partial identity remains `INCONCLUSIVE` and cannot create `VALIDATED` or `FIXED` state.
- Existing scan cost, queue, egress, and provenance behavior is unchanged except for bounded local analysis time.

### Epic 6: CLI, PR, CI, And SARIF

- As a developer, I want changed WebMCP definitions reviewed before merge so that new unsafe tool surfaces do not reach production unnoticed.
- As a repository owner, I want high-confidence enforcement without noisy blocking from advisory heuristics.

Acceptance criteria:

- CLI can analyze changed eligible files and emit human-readable and SARIF results using the shared control IDs.
- `gate --fail-on` includes WebMCP findings and preserves the existing severity threshold semantics.
- The self-contained GitHub Action runs a documented high-confidence subset and produces the same rule IDs and severities as the full analyzer for that common subset. CLI and full scans remain authoritative for structural controls.
- Drift coverage fails CI if Action rules diverge from their source of truth.
- High/Critical findings at or above the configured threshold fail; Medium/Low/Info advisory results do not fail a default High gate.
- SARIF includes file and line when known, concise remediation, and no source secrets.
- A clean advisory result explicitly states that it does not establish overall security.

### Epic 7: Page-Scoped Dashboard Tools

- As an authenticated LyraShield user, I want my browser agent to understand the page's security state so that I can get help without configuring a separate remote MCP connection.
- As a workspace owner, I want the browser tools to inherit current session permissions and never accept authority-bearing identifiers from the model.

Acceptance criteria:

- One launch-readiness tool registers only on the launch-readiness page, returns the current bounded report, and can focus visible blockers.
- One findings-review tool registers only on the findings page, can update visible filters, and explains only an optional selected finding visible to the workspace session.
- Scan preparation registers only where the existing form and valid targets are available.
- Scan preparation uses the declarative form API without autosubmit where compatible; a tested imperative adapter may only prepare the same visible form as fallback.
- `workspaceId`, user ID, permission scope, API keys, and evidence locations are never accepted from or returned to the agent.
- API routes remain the authorization authority and validate all inputs independently.
- Navigating away or changing page/workspace unregisters stale tools.
- Findings, repository-derived summaries, and other external content carry the untrusted-content annotation.

### Epic 8: Human Confirmation And Activity Receipts

- As a user, I want to see what an agent did and whether it changed anything so that browser-agent assistance remains understandable.
- As an operator, I want durable actions to continue through existing approval and audit paths so that WebMCP cannot become a bypass.

Acceptance criteria:

- Every WebMCP call produces a visible session receipt with tool, classification, start/end, result state, data class, untrusted status, UI change, and approval requirement.
- Read-only and UI-only receipts stay session-local and contain no sensitive input.
- Preparing a scan changes only visible form state and records `Human confirmation required` and `Job started: no`.
- A durable mutation occurs only after the existing human control is used; the existing API creates the authoritative audit record.
- Cancellation produces a cancelled receipt and propagates to in-flight browser work.
- Receipts have accessible live-region behavior without overwhelming screen-reader users.

### Epic 9: Durable Report Export

- As a developer or executive, I want WebMCP results included in existing reports so that agent-tool risk is part of release assurance rather than a detached artifact.
- As a public-share owner, I want sensitive source detail withheld while useful aggregate context remains available.

Acceptance criteria:

- Existing report snapshots include a versioned WebMCP section when relevant scan data exists.
- Developer reports include inventory, coverage, findings, and remediation detail within existing report limits.
- Executive reports emphasize counts, mutation/exposure posture, blockers, and limitations.
- Compliance reports include control IDs, evidence states, methodology, and provenance without claiming certification.
- Public/shared payloads exclude repository coordinates, raw snippets, evidence URIs, private schemas, and internal infrastructure data.
- Legacy reports render without the new section and remain valid.

### Epic 10: Production Release And Evaluation

- As the product team, we want repeatable unit, integration, browser, agent, deployment, and live checks so that the feature is supportable after the hackathon.

Acceptance criteria:

- Tool-selection evaluations cover expected prompts, ambiguous prompts, cancellation, invalid input, missing WebMCP support, cross-workspace attempts, and mutation attempts.
- Browser testing covers ChatGPT's in-app browser and supported Chrome WebMCP testing.
- Security headers are verified live on marketing and app origins.
- Exact-SHA CI, deployment, live tool discovery, manual UI behavior, agent behavior, and visual review are recorded separately.
- The public repository identifies the new post-August-25 work and retains a visible open-source license.
- The deployed project remains accessible through the judging period.
- The no-login Security Lab proves the primary product path. Authenticated testing uses a dedicated ordinary `DEVELOPER` user in an isolated judge workspace, never a special role, platform administrator, bypass, or predictable production seed. The existing role provides scan, finding, fix, retest, report, and agent access without billing or workspace-governance authority.
- Judge credentials appear only in Devpost's private testing instructions, are rotated before judging, remain valid through the judging period, and are revoked afterward. The account has bounded normal quotas, synthetic authorized targets, no customer data, no billing administration, and the same approval boundaries as every user.
- Search and answer-engine verification covers canonical URLs, indexability, sitemap, `llms.txt`, internal links, structured data, rendered answer blocks, WebMCP control registry freshness, performance, and mobile accessibility. WebMCP is never described as a ranking or citation guarantee.

## Edge Cases

- A page or browser does not support `document.modelContext`: all human workflows continue and an unobtrusive compatibility note is available.
- Two components try to register the same tool: registration fails closed, produces a developer-visible error, and does not leave stale handlers.
- Workspace changes while a call is running: abort the execution and unregister the old context before registering the new one.
- A finding contains prompt-injection text: return bounded untrusted content; never treat finding text as tool instructions.
- A scan option becomes invalid after the agent prepares the form: the existing UI revalidates and refuses submission.
- Source contains dynamic names, schemas, or `exposedTo`: inventory what can be proven and mark the rest inconclusive.
- The rewrite cannot preserve formatting or semantics confidently: return remediation steps without a patch.
- CI sees a renamed or moved tool: compare stable definition metadata and report the change without claiming runtime equivalence.
- Report data predates WebMCP receipts: omit the section or show a clearly versioned unavailable state.
- Analysis reaches file, byte, definition, output, or wall-time limits: return partial coverage and never a clean pass.

## What We Are Building

All ten epics above are in the committed production scope. Delivery may be split across dependency-ordered PRs and deployments, but the final acceptance requires every epic to be implemented and verified.

## What We Would Add With More Time

- Optional model-assisted adaptation of deterministic rewrite proposals after privacy and cost review.
- A supported customer-side runtime attestation SDK that compares deployed registered tools with the source inventory.
- Browser-extension inspection of arbitrary third-party pages, with explicit host permissions and a separate threat model.
- Organization policy profiles for approved origins, naming rules, and mutation classes.
- Historical tool-surface diff dashboards across releases.

These are post-hackathon extensions, not substitutes for the committed scope.

## Free And Paid Packaging

The free product must provide complete, trustworthy deterministic results rather than a crippled teaser. Free includes the no-login local Security Lab with all 10 controls, current-input inventory, deterministic rewrite preview/Apply/Undo/rerun, JSON/Markdown/SARIF export, public benchmark and control documentation, the focused account-less CLI check, and the self-contained GitHub Action subset.

Paid value begins when LyraShield manages a real repository and assurance lifecycle: connected private-repository scans, persisted inventory and findings, revision-bound manifests, historical Tool Surface Diff, centralized CI policy, approval-bound repository fix proposals, retests, monitoring, team workflows, durable audit, and immutable developer/executive/compliance reports. Dashboard WebMCP tools are included in the existing 14-day trial and every paid Cloud plan; Local/Desktop includes the repository capability under the existing paid BYOK license. Do not create a separate WebMCP add-on or change approved plan prices for this release.

## Submission Proof Points

- Same control IDs and detector version visible in the public local checker, repository scan, SARIF, and report.
- A real unsafe definition produces a visible finding, deterministic rewrite, clean rerun for the addressed control, and CI regression result.
- The browser agent uses WebMCP to operate live LyraShield page state rather than clicking arbitrary DOM controls.
- The scan preparation sequence visibly stops for human confirmation.
- The activity receipt distinguishes read, UI-only preparation, cancellation, and durable mutation; the user sees a compact latest-status chip and can expand bounded session history.
- The final report binds WebMCP inventory and coverage to the exact scanned revision and preserves LyraShield's claims limits.
