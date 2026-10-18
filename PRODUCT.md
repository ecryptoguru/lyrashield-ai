# LyraShield AI — Product Context

<!-- impeccable:product-schema 1 -->

This shared record captures durable product context for the apps and packages in
this repository. [PRD.md](./PRD.md) owns product scope and release gates;
[codebase.md](./codebase.md) owns architecture and implementation mapping;
[AGENTS.md](./AGENTS.md) owns engineering and operating rules. Running code,
schema, migrations, CI, and live evidence override documentation. Current release
status, prices, provider configuration, and deployment revisions belong in their
existing sources of truth rather than this record.

## Platform

web

The Cloud application and marketing site are web surfaces. Local/Desktop uses a
Tauri application with a React/Vite frontend on macOS and Windows. A desktop
wrapper does not imply an iOS, Android, or OS-adaptive visual language.

## Users

Primary users are AI app builders, founders, agencies, small SaaS teams, and
developers preparing software for release. They need to check an app or pull
request, understand and remediate findings, monitor authorized targets, and share
defensible evidence with clients, investors, or engineering colleagues.

## Product Purpose

LyraShield AI provides evidence-backed release assurance for AI-built software:

`Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report`

Success means users understand what was assessed, what the evidence supports,
what remains uncertain, and which action to take next. The product must make
release decisions more informed without implying certainty beyond retained
evidence.

## Positioning

The product joins assessment, retained evidence, approval-gated fix proposals,
retests, and assurance reports in one workflow. It distinguishes detected risks,
retest-confirmed outcomes, independently verified findings, and inconclusive
results. Scores and model confidence provide context; they are never proof by
themselves.

## Operating Context

- Cloud provides a hosted application and worker orchestration; LyraShield pays
  the model cost. Local/Desktop uses customer-supplied model credentials.
- Authorized targets include repositories, deployed web applications, and APIs.
  Assessment scope and target authorization must remain explicit.
- People use workspaces, projects, targets, findings, evidence, approvals, retests,
  and reports in the dashboard. Coding-agent workflows also use MCP, the CLI,
  SDK, and plugin integrations.
- Optional Cloud Sync transfers selected Local findings; nothing syncs by default.
- Marketing and public tools help visitors understand and evaluate the product.
  The passive Lite Check is separate from the authenticated full scan pipeline.

## Capabilities and Constraints

- Preserve `DETECTED`, `VALIDATED`, `VERIFIED`, and `INCONCLUSIVE` as distinct
  evidence states. `VALIDATED` means a trusted deterministic retest confirmed
  absence under complete coverage; `VERIFIED` requires independent trusted
  verification evidence. Missing coverage or engine-only absence stays
  inconclusive.
- Record assessed scope, evidence provenance, coverage limits, and unassessed
  checks. Never turn a missing result into a clean bill of health.
- Fix proposals require approval. A proposed or applied change does not establish
  a successful retest or authorize automatic Fix PR execution.
- Preserve workspace isolation, role-based authorization, private evidence, and
  deliberately bounded public report and scorecard payloads.
- Desktop stores BYOK credentials in the OS keychain and contains no LyraShield
  model keys. Source implementation does not establish signed public distribution.
- Users see usage minutes rather than private provider costs. Do not expose model
  spend in dashboards or public payloads, or name the upstream engine publicly.
- Production availability, signed Desktop releases, and integration acceptance
  require their own current evidence. A source feature or passing local check is
  not a deployment claim.
- Future app-specific context may clarify distinct user jobs and constraints;
  this shared record does not choose page strategy or replace release gates.

## Brand Commitments

- Public name: **LyraShield AI**. Canonical domain: `lyrashieldai.com`.
- Preserve existing `@lyrashield/*` and `LYRASHIELD_*` identifiers unless the
  founder explicitly approves a rename.
- Explain risks in plain language while keeping technical evidence available.
  Existing product language includes “Check my PR,” “Test my app,” “Full launch
  review,” “Proof,” “Fix proposal,” and “Retest.”
- Never claim certification, compliance, guaranteed security, universal detection,
  adversarial robustness, or unnamed “AI safety testing.” Customer, benchmark,
  accuracy, and speed claims need measured, approved evidence.
- Existing visual guidance remains in [DESIGN.md](./DESIGN.md); this record does
  not prescribe a new visual world.

## Evidence on Hand

- [PRD.md](./PRD.md), [codebase.md](./codebase.md), and
  [docs/user-guide.md](./docs/user-guide.md) describe scope, workflows, contracts,
  and their limits. Verify changing implementation facts against current source.
- [docs/README.md](./docs/README.md) maps maintained documentation and operator
  runbooks. Release and runtime receipts must be checked before public claims.
- [apps/marketing/public/product/README.md](./apps/marketing/public/product/README.md)
  documents real, redacted product captures, including paired dashboard themes.
  Check capture freshness before presenting them as current UI.
- Source, schemas, tests, manifests, and retained receipts provide inspectable
  evidence. No testimonials, customer logos, benchmark results, or deployment
  claims are authorized merely by this initialization.

## Product Principles

1. Make evidence and uncertainty visible wherever they affect a decision.
2. Guide users through the next useful action with clear language and accessible
   technical depth.
3. Keep authorization, privacy, and user approval integral to the workflow.
4. Preserve the same evidence meaning across Cloud, Desktop, and agent interfaces.
5. Separate implemented capability from tested, deployed, and independently
   verified outcomes.

## Accessibility & Inclusion

Preserve the repository's shared accessible controls and meaningful loading,
empty, error, and recovery states. Frontend work must consider desktop and mobile
web behavior. No additional audience-specific accessibility requirement or formal
conformance target was established during this initialization.
