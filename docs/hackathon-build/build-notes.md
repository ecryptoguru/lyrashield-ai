# Hackathon Build Notes

## 2026-08-29 — Direction locked

- The participant rejected a demo-first or temporary-judge-access framing. The capability must be a real production LyraShield feature with full access subject to existing authentication, tenancy, permissions, rate limits, and approval boundaries.
- Selected scope: public Security Lab, shared deterministic checker, repository source scanner, free checker, deterministic safe rewrite, dashboard tools, human confirmation, visible receipts, PR/CI gate, report export, live deployment, and evaluation suite.
- Architecture consolidation: one shared analyzer powers free, worker, CLI/CI, and report surfaces; one browser adapter owns page-scoped WebMCP registration and receipts.
- Differentiation added: versioned Tool Surface Inventory, stable definition hashes, policy results, diff-aware CI regression detection, and evidence-bound report output.
- Simplification: extend existing reports and evidence paths; do not add a parallel report type, evidence store, browser extension, crawler, or chatbot.
- Build mode requested: autonomous, production quality, all selected capabilities. Ordinary build work should proceed without repeated questions; founder-gated production mutations remain gated by existing policy.
- Deepening rounds: requirements were clarified through multiple direct user corrections; no additional interview round is required before writing the production plan.

## 2026-08-29 — UX/DX and current-spec audit

- Reduced the public lab from five overlapping WebMCP tools to two focused tools: analyze current source and prepare a rewrite. Apply, Undo, export, sample loading, and `getTools()` diagnostics remain human controls.
- Reduced authenticated dashboard exposure to one tool per page task: launch-readiness review, findings review, and scan preparation. Scan preparation is declarative-first without autosubmit and retains a tested imperative preparation-only fallback.
- Split browser-safe policy/model code from heavy TypeScript/parse5 discovery. The parser loads only in a dedicated Worker after interaction, with a bundle budget and tests proving general marketing/dashboard bundles stay clean.
- Replaced hand-maintained ambient declarations with official `webmcp-types`; retained a thin native runtime adapter rather than another framework abstraction.
- Corrected `WEBMCP-04`: missing an explicit `tools=(self)` header is hardening because `self` is the default, and missing OAC `?1` is not itself a vulnerability. Explicit wildcard/delegated exposure, OAC `?0`, or `document.domain` remain findings.
- Restricted automatic rewrites to deterministic syntax-safe edits. Trusted origins and mutation semantics now produce guided patches only; agent prepares, human applies, UI reruns the check, and reversible changes offer Undo.
- Resolved the Action architecture: the self-contained Action ships a clearly labeled high-confidence subset with drift tests; CLI, full scan, and local lab remain authoritative for structural analysis.
- Simplified activity UX to a latest-status chip plus 20-item expandable session history with bounded, redacted receipts and accessible announcements.

## 2026-08-29 — Judge access and public discovery

- Primary judge path is the complete public Security Lab with no login. Authenticated dashboard testing uses one ordinary `DEVELOPER` account in an isolated synthetic workspace through normal production auth and tenancy; this existing role covers scan, finding, fix, retest, report, and agent workflows without billing or workspace governance. No judge role, auth bypass, platform privileges, customer data, or production seed.
- Judge credentials belong only in Devpost private testing instructions or an approved secret store, with rotation before judging and revocation afterward.
- Free Tools gains a featured WebMCP Security group, but all interactive modes remain on one canonical checker page to avoid fragmented UX and thin SEO pages.
- Add one substantial `/webmcp` pillar page, a public control registry generated from shared metadata, existing sitemap/structured-data/`llms.txt` integration, internal links, and a single read-only public explanation tool. Claims remain bounded: agent-readable structure may improve answer quality and conversion but does not prove ranking, indexing, or citation.

## 2026-08-29 — Packaging confirmed

- Free keeps complete deterministic accuracy: all 10 local controls, inventory, rewrite preview/Apply/Undo/rerun, local exports, benchmark/docs, focused account-less CLI checking, and the Action's documented high-confidence subset.
- Paid starts at managed repository assurance: persistence, revision-bound evidence, historical Tool Surface Diff, centralized CI policy, repository fix/retest workflows, monitoring, teams, durable audit, and immutable reports.
- Dashboard WebMCP tools ship in the existing trial and paid Cloud plans; Local/Desktop receives repository capability under its existing license. No separate WebMCP add-on or price change.
