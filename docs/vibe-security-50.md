# Vibe Security 50 Coverage Contract

Version: `vibe-security-50/1.0.0`

The executable source of truth is `packages/security/src/vibe-security-controls.ts`. Every new full scan sends the 43 machine-testable controls to the existing engine, records a `coverage_contract` scan event, and stores one immutable coverage receipt for each of the 50 controls. A control is counted as a finding only when a scanner or the engine returns evidence; an unreported control is never presented as passed.

## Coverage strategies

- **Deterministic (10):** 3, 14, 23, 27, 28, 29, 31, 32, 37, 45. These use bounded secrets, URL, dependency, agent-instruction, or workflow checks.
- **Hybrid (6):** 1, 2, 20, 38, 39, 47. A deterministic signal can identify a risky pattern, but the engine or a reviewer must establish exploitability and context.
- **Engine-led (27):** 4-13, 15-19, 21-22, 24-26, 30, 33, 40-42, 44, 49. These require authentication, data-flow analysis, live interaction, business context, or exploit validation.
- **Evidence-required (7):** 34, 35, 36, 43, 46, 48, 50. Audit coverage, monitoring, restore proof, deployment egress, test independence, multi-agent trust, and accountable review cannot be proven safely from a URL or repository scan alone.

## Honest result language

- `DETECTED`: evidence was returned for the control.
- `NO_FINDING`: the assigned scanner completed without returning a mapped finding. This is not independent verification and must not be shown as `passed`.
- `INCONCLUSIVE`: the control was requested where applicable, but the available scan could not establish an outcome.
- `NOT_APPLICABLE`: the control does not apply to the scanned target type or available subject.
- `EVIDENCE_REQUIRED`: one of the seven operational controls needs deployment, process, or human-review proof that a code or URL scan cannot establish safely.
- Never use `passed`, `clean`, or `covered` merely because no finding was returned.

The scan-detail experience groups these receipts by control family and exposes the complete 50-control ledger on demand. The seven evidence-required controls are presented as user actions, not scanner failures.

The dashboard exposes this contract through Release Check, Code Review, and Deep Security Review; Weekly Monitor is the recurring Safe workflow. These presets change review depth and budget, not the definition of the 50 controls. URL/API scans show only applicable deterministic receipts and never pretend repository or operational controls ran. See `userguide.md` §§8–10 for the user-facing interpretation.

## Cost controls

The checklist reuses the current engine invocation and existing SCA, secrets, and URL phases. Maven and Gradle manifests use the existing batched OSV call. CVE-bearing dependency findings may also receive bounded, cached enrichment from the CISA Known Exploited Vulnerabilities catalog and FIRST EPSS API; either source may fail without failing the scan, and enrichment never changes severity or verification state. Agent-instruction and workflow checks read only a small allowlist of bounded files.

Repository scans use Luna/medium for Safe, Quick, and Standard or Terra/high for Deep and Custom. Their default engine caps are $1.20, $1.20, $3.20, $15, and $15 respectively. URL/API targets skip the engine and have $0 AI-model cost. The cost ledger prefers engine-reported cost and uses the versioned official GPT-5.6 rate card only for complete standard-context counters when cost is absent.

## Release proof

Unit and contract tests prove registry completeness, instruction delivery, evidence separation, URL signatures, dependency parsing, agent-instruction detection, CI confused-deputy detection, and orchestration. A local Safe scan has exercised the worker, Docker sandbox, Luna/medium routing, and scan-event path against an approved public repository; it returned zero findings and a recorded budget-overage warning. That scan does not prove all controls, production behavior, or a security guarantee. Production coverage still requires an approved production target, inspected image provenance, retained artifacts where findings exist, and deployment-level egress control documented in `PRD.md`.
