# Vibe Security 50 Coverage Contract

Version: `vibe-security-50/1.0.0`

The executable source of truth is `packages/security/src/vibe-security-controls.ts`. Every scan sends the 43 machine-testable controls to the existing engine and records a `coverage_contract` scan event. A control is counted as a finding only when a scanner or the engine returns evidence; an unreported control is never presented as passed.

## Coverage strategies

- **Deterministic (10):** 3, 14, 23, 27, 28, 29, 31, 32, 37, 45. These use bounded secrets, URL, dependency, agent-instruction, or workflow checks.
- **Hybrid (6):** 1, 2, 20, 38, 39, 47. A deterministic signal can identify a risky pattern, but the engine or a reviewer must establish exploitability and context.
- **Engine-led (27):** 4-13, 15-19, 21-22, 24-26, 30, 33, 40-42, 44, 49. These require authentication, data-flow analysis, live interaction, business context, or exploit validation.
- **Evidence-required (7):** 34, 35, 36, 43, 46, 48, 50. Audit coverage, monitoring, restore proof, deployment egress, test independence, multi-agent trust, and accountable review cannot be proven safely from a URL or repository scan alone.

## Honest result language

- `finding`: evidence was returned for a control.
- `requested where applicable`: the engine received the control, but this is not proof it exercised every path.
- `evidence required`: the user must provide deployment or process proof.
- Never use `passed`, `clean`, or `covered` merely because no finding was returned.

## Cost controls

The checklist reuses the current engine invocation and existing SCA, secrets, and URL phases. It adds no service, database table, dependency, or network request. Maven and Gradle manifests now use the existing batched OSV call. Agent-instruction and workflow checks read only a small allowlist of bounded files.

## Release proof

Unit and contract tests prove registry completeness, instruction delivery, evidence separation, URL signatures, dependency parsing, agent-instruction detection, CI confused-deputy detection, and orchestration. A local Safe scan has exercised the worker, Docker sandbox, Luna/medium routing, and scan-event path against an approved public repository; it returned zero findings and a recorded budget-overage warning. That scan does not prove all controls, production behavior, or a security guarantee. Production coverage still requires an approved production target, inspected image provenance, retained artifacts where findings exist, and deployment-level egress control documented in `PRD.md`.
