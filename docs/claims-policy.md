# Public claims policy

> **Owner:** Founder, with engineering, security, and legal review
>
> **Review cadence:** Quarterly and before any release that changes a public assurance, security, privacy, compliance, certification, benchmark, or guarantee claim

This policy governs public product, marketing, investor, marketplace, and sales claims. Product behavior and evidence boundaries live in `PRD.md`, `AGENTS.md`, and the public papers; this file owns the review obligation.

## Current boundary

Claims must name their scope, evidence, date or version where relevant, and material limitations. LyraShield AI may describe itself as evidence-backed release assurance for AI-built software. It must not claim certification, compliance, guaranteed security, universal detection, unnamed AI safety testing, or proven adversarial robustness without the external attestation, reproducible evaluation, formal certificate, or bounded contractual basis required for that exact claim.

First-party evaluation results must remain labeled first-party and tied to the named corpus, method, and result. They must not be described as independent review. A clean or completed scan must not be presented as universal security proof.

## Required controls

- A human reviewer must approve copy before every indexable marketing deployment.
- CI should reject newly introduced positive claim patterns such as `is certified`, `is compliant`, `SOC 2 certified`, `ISO 27001 certified`, `guarantees security`, `universal security`, unnamed `AI safety tested`, and `adversarial robustness proven`. Negative disclosures and policy text need an explicit reviewed allowance.
- The owner must review this policy quarterly and before any claim-changing release. Record the review date and resulting changes in the pull request that updates this file.
- Claims of external certification or compliance require the issued attestation or certificate for the stated scope and period.
- Claims of measured detection or evaluation require a reproducible corpus, versioned method, published bounded result, and clear first-party or independent-review status.
- Any guarantee-shaped claim requires counsel-approved scope, prerequisites, remedy and liability terms, plus applicable insurance review.

## Open evidence obligations

- The published 2026-08-13 OWASP result and AILuminate demo observation remain first-party evidence. Independent review is required before using independent-review language.
- The removed historical evaluation runner must be restored or replaced before claiming clean-checkout reproducibility for those results.
- SOC 2, ISO 27001, ISO 42001, and similar claims remain unavailable until the relevant external process is complete and its exact scope can be cited.

## Primary references

- [AICPA SOC 2 and assurance resources](https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2)
- [NIST ARIA](https://ai-challenges.nist.gov/aria)
- [NIST AI 100-2e2025](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-2e2025.pdf)
- [MLCommons AILuminate](https://mlcommons.org/benchmarks/ailuminate/)
- [OWASP GenAI Red Teaming and Evaluation](https://genai.owasp.org/initiative/red-teaming-evaluation/)

Historical legal analysis, proposed certification roadmaps, cost estimates, and the complete reference list remain in Git at commit `e3fa791f` under `docs/claims-readiness.md`. Revalidate external requirements and obtain qualified legal advice before relying on them.
