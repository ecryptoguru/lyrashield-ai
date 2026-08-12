# Vibe Security 50 Coverage Contract

Version: `vibe-security-50/1.1.0`

The executable source of truth is `packages/security/src/vibe-security-controls.ts`. Every new full scan routes 43 code/URL review controls through the applicable deterministic, hybrid, or engine-led path, records a `coverage_contract` scan event, and stores one immutable receipt for each of the 50 controls. A control is counted as a finding only when a scanner or the engine returns evidence; an unreported control is never presented as passed.

## Coverage strategies

- **Deterministic (5):** 3, 27, 29, 37, 45. These return a bounded repeatable observation over the supplied repository or response.
- **Hybrid (10):** 1, 2, 14, 20, 28, 31, 32, 38, 39, 47. A deterministic signal can identify a risky pattern, but an unmatched signal is inconclusive; exploitability and context still need review.
- **Engine-led (28):** 4-13, 15-19, 21-26, 30, 33, 40-42, 44, 49. These require authentication, data-flow analysis, live interaction, business context, or exploit validation.
- **Evidence-required (7):** 34, 35, 36, 43, 46, 48, 50. Audit coverage, monitoring, restore proof, deployment egress, test independence, multi-agent trust, and accountable review cannot be proven safely from a URL or repository scan alone.

## Honest result language

- `DETECTED`: evidence was returned for the control.
- `NO_FINDING`: the assigned scanner completed without returning a mapped finding. This is not independent verification and must not be shown as `passed`.
- `INCONCLUSIVE`: the control was requested where applicable, but the available scan could not establish an outcome.
- `NOT_APPLICABLE`: the control does not apply to the scanned target type or available subject.
- `EVIDENCE_REQUIRED`: one of the seven operational controls needs deployment, process, or human-review proof that a code or URL scan cannot establish safely.
- Never use `passed`, `clean`, or `covered` merely because no finding was returned.

The scan-detail experience groups these receipts by control family and exposes the complete 50-control ledger on demand. The seven evidence-required controls are outside-scan requirements, not scanner failures. Version 1.1 does not claim an evidence-submission workflow that the product does not yet provide.

The dashboard exposes this contract through Release Check, Code Review, and Deep Security Review; Weekly Monitor is the recurring Quick workflow. These presets change review depth, not the definition of the 50 controls. URL/API scans use the versioned `url-scan/2.0.0` capability registry with six released profiles (Surface, Expanded Surface, Behavioral Surface, Endpoint, Contract, Contract Behavior Review) and show only applicable deterministic receipts — they never pretend repository or operational controls ran. See `userguide.md` §§8–10 for the user-facing interpretation and `packages/types/src/url-scan-capabilities.ts` for the contract source of truth.

## Execution controls

The checklist reuses the current engine invocation and existing SCA, secrets, URL, and agent-configuration phases. Maven and Gradle manifests use the existing batched OSV call. CVE-bearing dependency findings may also receive bounded, cached enrichment from the CISA Known Exploited Vulnerabilities catalog and FIRST EPSS API; either source may fail without failing the scan, and enrichment never changes severity or verification state. Agent-instruction and workflow checks read only a small allowlist of bounded files. The engine currently emits findings with control IDs, not negative per-control assessments, so unmatched engine-led controls remain inconclusive.

Repository scans use Luna/medium for Safe, Quick, and Standard. Deep and Custom use a Terra/medium coordinator with Luna/high specialists. URL/API targets skip the engine. Protected limits and provider reconciliation remain internal and are not displayed in the dashboard.

## Release proof

Unit and contract tests prove registry completeness, instruction delivery, evidence separation, URL signatures, dependency parsing, agent-instruction detection, CI confused-deputy detection, and orchestration. An approved production Standard repository scan exercised the deployed worker/engine path and stored a Vibe Security 50 ledger. That run is target- and version-scoped, included inconclusive and evidence-required receipts, and is not proof of all controls, universal coverage, or a security guarantee. Broader production assurance still requires current image provenance, retained artifacts, and deployment-level evidence.
