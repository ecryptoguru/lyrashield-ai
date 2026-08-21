# LyraShield AI — Claims Readiness Map

> **Status:** Source of truth for what LyraShield AI can and cannot claim today, and what it would take to make each prohibited claim legitimate. Maintained alongside `AGENTS.md` and `docs/ai-assurance-framework-mapping.md`.
>
> **Last reviewed:** 2026-08-21
>
> **Owner:** Founder (with engineering, security, and legal input)

## Purpose

This document exists so that every contributor, marketer, auditor, and reviewer can answer one question without ambiguity:

> _Can we say X today? If not, what would it take?_

It covers five claim categories that LyraShield has deliberately avoided so far:

1. "SOC 2 compliant"
2. "Certified"
3. "Guarantees security"
4. "AI safety tested"
5. "Adversarial robustness proven"

For each, this document records:

- What the claim legally or technically means.
- What LyraShield has today that supports or relates to it.
- What is missing.
- What it would take to make the claim legitimate.
- What can be said honestly today.
- A realistic timeline and rough cost.

## Governing principle

Public claims must be **evidence-backed, scope-bounded, and limitation-aware**. The existing product positioning — "evidence-backed release assurance for AI-built software" — is defensible because it describes what the product does (records evidence, produces immutable reports) without asserting what it proves (certification, compliance, universal security, adversarial robustness).

Any move from "evidence-backed" to "certified," "compliant," "guaranteed," "safety tested," or "proven robust" requires external attestation, a reproducible evaluation corpus, a defined threat model, or a formal certificate — not a marketing decision.

---

## Claim 1: "SOC 2 compliant"

### What it means

"SOC 2 compliant" is not a self-assertion. It means a licensed CPA firm has issued a **SOC 2 Type I or Type II attestation report** under AICPA AT-C Section 105/205, stating that LyraShield's controls meet the AICPA Trust Services Criteria (TSC) and (for Type II) operated effectively over a defined 3–12 month observation window.

Saying "SOC 2 compliant" without that report is a false attestation, enforceable by the FTC (Section 5), state AGs (UDAP statutes), and customer contracts.

### What LyraShield has today

- `AuditLog` model with `prevHash`/`hash` tamper-evident chaining (`packages/db/prisma/schema.prisma` lines 1066–1086).
- Workspace RLS with `FORCE RLS` and `withWorkspaceRLS()`.
- Approval-gated fix proposals (no auto-merge).
- Immutable report snapshots.
- `ScanResultManifest` and `ScanCoverageReceipt` for evidence provenance.
- API key management with workspace scoping.
- SCA/secret scanning in CI.
- `terms.astro` and a monitored abuse contact.

### What is missing

#### Policies and organization (Phase 1 — Weeks 1–3)

- [ ] Formal written security policy set: Access Control, Change Management, Incident Response, Acceptable Use, Vendor Risk, Data Retention, Encryption, Logging/Monitoring. Each must have an owner (role, not person), approval date, review cycle.
- [ ] Documented system description: the boundary of "the system" — web, worker, marketing, scanner, Postgres, Redis, Azure Container Apps, Cloudflare Workers/KV/D1, Upstash, GitHub, OpenAI/Azure AI. This becomes Section I of the SOC 2 report.
- [ ] Risk assessment register with identified risks, likelihood, impact, owner, mitigation.
- [ ] Background check policy for personnel with production access.
- [ ] Security awareness training program with completion records.

#### Technical controls (Phase 2 — Weeks 4–10)

- [ ] **MFA enforcement** on all admin surfaces (dashboard, worker VM, Cloudflare dashboard). Add TOTP/WebAuthn enforcement for any role above `member`.
- [ ] **Centralized log aggregation** with retention ≥ 12 months. `AuditLog` lives in Postgres; SOC 2 auditors want SIEM-style queryable logs. Add log export to a dedicated log store with tamper-evidence and alerting.
- [ ] **Change management evidence**: PR approvals, deployment logs, rollback procedures. Need a documented promotion policy (who can merge to `main`, required reviewers, deployment gate) and evidence that it ran for the entire observation window.
- [ ] **Vulnerability management cadence**: documented weekly scan + critical-finding SLA (e.g., critical patched in 7 days). Need the SLA documented and tickets showing adherence.
- [ ] **Incident response runbook** + at least one tabletop exercise per year with postmortem.
- [ ] **Backup and restore**: documented backup schedule, restore test evidence. Postgres/Supabase backups exist; need a restore drill on record.
- [ ] **Encryption at rest**: verify Postgres TDE, R2 bucket encryption, worker VM disk encryption. Document key management.
- [ ] **Vendor risk assessments** for OpenAI/Azure AI, Supabase, Cloudflare, Upstash, GitHub. Each needs a completed security questionnaire and signed DPA on file.
- [ ] **Offboarding checklist** with access revocation timestamps within 24h.

#### Evidence automation (Phase 2 — ongoing)

- [ ] Automated evidence collection: export MFA enforcement status, access reviews, PR approvals, deployment logs, scan results on a weekly cadence.
- [ ] Quarterly access review with sign-off.

#### External engagement (Phase 3 — the audit itself)

- [ ] Engage a CPA firm (Barr, Moss-Adams, Schellman, A-LIGN, etc.).
- [ ] Type I first (point-in-time design): ~6–10 weeks.
- [ ] Type II observation window: 3–12 months of operating evidence, then 4–6 weeks of fieldwork + report.

### Codebase additions needed

- `packages/db` — add `AccessReview`, `PolicyAcceptance`, `VendorAssessment`, `IncidentReport` models.
- `apps/web` — admin UI for access reviews, policy acceptance tracking, vendor register.
- `apps/worker` — evidence export job that emits weekly CSV/JSON of control evidence to an auditor-readable bucket.
- `docs/compliance/` directory with the policy library, system description, risk register, and evidence index.

### What can be said honestly today

- "Evidence-backed release assurance for AI-built software" (current positioning — defensible).
- "Designed against SOC 2 Trust Services Criteria" — only after the gap assessment confirms alignment.
- "Undergoing SOC 2 Type II audit" — only after the CPA firm is engaged and the observation window has started.
- "SOC 2 Type II report available" — only after the report is issued.

### Timeline and cost

- **Timeline:** 6–12 months from gap assessment to Type II report.
- **Cost:** $40k–$120k for the audit firm + internal engineering time for evidence automation.

---

## Claim 2: "Certified"

### What it means

"Certified" without qualification is meaningless and risky. With qualification, it points to a specific attestation:

- **SOC 2 certified** → see Claim 1 (technically "attested," but market usage says "certified").
- **ISO 27001 certified** → an accredited certification body issues a certificate after a Stage 1 (documentation) and Stage 2 (implementation) audit, plus annual surveillance audits and a 3-year recertification.
- **ISO 42001 certified** → AI management system certification (2023 standard), same accreditation body process.
- **HIPAA certified** → does not exist as a formal certification; HHS does not issue one. Anyone claiming "HIPAA certified" is misrepresenting.
- **PCI DSS certified** → a QSA (Qualified Security Assessor) issues a Report on Compliance (RoC) or you self-assess via an SAQ. Required only if you process card data.

### What is needed for ISO 27001 (the most common "certified" claim after SOC 2)

- [ ] **ISMS (Information Security Management System)**: a documented management system covering scope, leadership commitment, risk assessment, objectives, internal audit, management review, continual improvement.
- [ ] **Statement of Applicability** mapping Annex A controls (93 controls in the 2022 version) to your environment, with justification for any exclusions.
- [ ] **Risk treatment plan** with residual risk accepted by leadership.
- [ ] **Internal audit** by someone independent of the implementer, before the certification audit.
- [ ] **Management review** with documented minutes.
- [ ] **Stage 1 audit** (document review) + **Stage 2 audit** (implementation evidence) by an accredited body (BSI, DNV, Bureau Veritas, Schellman, etc.).
- [ ] **Annual surveillance audits** for 3 years, then full recertification.

### Codebase additions

Same as SOC 2 plus:

- `docs/isms/` — ISMS manual, SoA, risk treatment plan, internal audit reports.
- `packages/db` — `RiskRegister`, `ControlImplementation`, `InternalAuditFinding` models.
- `apps/web` — admin views for the ISMS evidence chain.

### What can be said honestly today

- "Aligned to ISO 27001 Annex A controls" — only after a gap assessment confirms it.
- "ISO 27001 certified" — only after the certificate is issued.

### Timeline and cost

- **Timeline:** 6–9 months to first certificate.
- **Cost:** $25k–$60k for a small SaaS + internal time.

---

## Claim 3: "Guarantees security"

### What it means legally

This is the most dangerous of the five claims. Case law consistently holds that exculpatory and limitation-of-liability clauses in security contracts are generally enforceable, but they do **not** protect against claims of **gross negligence, willful misconduct, or fraudulent misrepresentation**.

Relevant precedent:

- _Royal Indem. Co. v. Security Guards, Inc._, 255 F. Supp. 2d 497 (E.D. Pa. 2003) — limitation of liability enforced, but gross negligence not exempted.
- _Jewels by Iroff, Inc. v. Securitas Tech. Corp._, 2023 U.S. Dist. LEXIS 172391 — exculpatory clause enforced, but court noted limits for willful/gross negligence.
- _David Gutter Furs v. Jewelers Protection Services_, 1991 — exculpatory clause reversed where gross negligence alleged.

Saying "guarantees security" in marketing copy, then having a breach, opens LyraShield to:

- **FTC Section 5** deceptive advertising action.
- **State UDAP** actions by state AGs.
- **Breach of contract** and **negligent misrepresentation** claims by customers who relied on the claim.
- **Investor/securities** exposure if the claim appeared in fundraising materials.

No security vendor that ships a real product says "guarantees security." The defensible formulations are:

- "Provides evidence-backed assurance for [defined scope]"
- "Reduces risk for [defined threat classes] when configured per [documented baseline]"
- "Detects [named categories] with [measured precision/recall] on [named corpus]"

### What is needed to make a _bounded_ guarantee defensible

If LyraShield ever wants to make any guarantee-shaped statement, it must be:

1. **Scope-bounded**: name the exact threat classes, target types, and configurations covered.
2. **Evidence-backed**: cite a reproducible evaluation corpus with measured precision, recall, and false-positive rate.
3. **Condition-qualified**: state the prerequisites (e.g., "when all 50 Vibe Security controls are run in Standard mode on a repository target with approved egress").
4. **Remedy-limited**: the contract caps liability (typically to fees paid in the prior 12 months).
5. **Disclaimer-paired**: "No security tool can detect all vulnerabilities. This guarantee applies only to the defined scope."

### Codebase additions needed for a bounded guarantee

- [ ] **Evaluation corpus**: a versioned, reproducible set of AI-built apps with known planted and real vulnerabilities. Currently LyraShield has test fixtures but no public evaluation corpus. Need `packages/eval/` with seeded repos, expected findings, and a runner that emits precision/recall per control.
- [ ] **Published metrics page**: `/methodology` already exists; add a `/eval-results` page with per-control precision/recall on the corpus, refreshed each release.
- [ ] **Contract template** with the bounded guarantee language and liability cap, reviewed by counsel.
- [ ] **SLA engine** in `apps/web` that tracks whether a customer met the guarantee conditions (mode, coverage, egress) and emits a guarantee-eligibility record per scan.
- [ ] **Cyber E&O insurance** ($1M–$5M coverage, $5k–$25k annual premium).

### What can be said honestly today

- "Evidence-backed release assurance for AI-built software" (current positioning — defensible).
- "Detects [named categories] with [measured] precision on [named corpus]" — only after the eval corpus exists.
- "Guarantees security" — **never**, unless backed by a contractual liability commitment and insurance.

### Timeline and cost

- **Timeline:** 3–6 months for the eval corpus + legal review.
- **Cost:** $5k–$25k/year for cyber E&O insurance + legal fees for contract review.

---

## Claim 4: "AI safety tested"

### What it means

"AI safety tested" implies the AI components of LyraShield (the GPT-5.6 Terra/Luna scan engine, the MCP server, the agent plugin) have been evaluated against a recognized AI safety testing framework.

### Credible frameworks

- **NIST ARIA** (Assessing Risks and Impacts of AI) — three levels: model testing, red-teaming, field testing. See <https://ai-challenges.nist.gov/aria>.
- **NIST AI 100-2e2025** — Adversarial Machine Learning taxonomy and terminology. See <https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-2e2025.pdf>.
- **MLCommons AILuminate** — standardized safety benchmark with 12 hazard categories, 24k prompts per language, jailbreak benchmark v0.5. See <https://mlcommons.org/benchmarks/ailuminate/>.
- **ISO/IEC AWI TS 42119-7** — Red teaming of AI systems (in development). See <https://www.iso.org/standard/91240.html>.
- **ISO/IEC AWI TS 42119-8** — Quality assessment of prompt-based text-to-text generative AI (in development). See <https://www.iso.org/standard/91609.html>.
- **OWASP Gen AI Security Project** — red teaming and evaluation guidelines for LLMs. See <https://genai.owasp.org/initiative/red-teaming-evaluation/>.
- **HarmBench** — academic standardized evaluation framework for automated red teaming. See <https://proceedings.mlr.press/v235/mazeika24a.html>.
- **UK AISI evaluations** — government safety institute evaluations for frontier models. See <https://www.gov.uk/government/publications/ai-safety-institute-approach-to-evaluations>.

### What LyraShield has today

- `packages/mcp/src/prompt-injection-guard.ts` — a regex-based prompt-injection guard for MCP tool calls. This is a **defensive filter**, not a safety evaluation.
- `packages/security/src/redos-guard.test.ts` — ReDoS guard tested against adversarial inputs. This is a **deterministic-input robustness test**, not an AI safety evaluation.
- `packages/security/src/instruction-safety.test.ts` — instruction safety tests.
- `packages/mcp/src/prompt-injection-guard.test.ts` — prompt injection guard tests.
- `apps/marketing/src/data/ai-safety-results.json` — versioned result artifact from the 2026-08-13 PromptInjectionGuard evaluation: 42 OWASP cases across four assessment areas and an observational MLCommons AILuminate demo run of 292 prompts across three categories.
- `packages/evidence-storage` — Envelope encryption (AES-256-GCM) for scan artifacts with self-describing binary format ("LSEV1"), fail-closed key management, S3-compatible storage (Cloudflare R2/AWS S3) with client-side encryption.

The first four entries are defensive filters and deterministic-input robustness tests, not a formal AI safety evaluation on their own. The recorded first-party result supports only the bounded wording below. The historical runner was removed as unused in `b96e597`, so the artifact is inspectable but cannot currently be rerun from a clean checkout.

### What LyraShield would need to do

#### For the scan engine (GPT-5.6 Terra/Luna wrapper)

- [ ] Run the engine against a published adversarial test suite: prompt-injection attempts, jailbreaks, data-exfiltration attempts, instruction-override attempts.
- [ ] Build a **red-team test harness** in `packages/eval/ai-safety/` that:
  - Submits a corpus of adversarial prompts (from MLCommons AILuminate public practice set or HarmBench).
  - Records whether the engine refuses, complies, or leaks.
  - Emits a per-hazard-category safety grade.
- [ ] Publish the methodology and results on `/ai-safety` (new page) with the test corpus version, model version, date, and per-category scores.
- [ ] Have the results independently reviewed (by AISI, a third-party red-team firm, or at minimum an internal reviewer who did not build the guard).

#### For the MCP server and agent plugin

- [ ] Run the OWASP Gen AI Security Project red-team checklist against the MCP tools.
- [ ] Test for: tool-call injection, prompt injection via scan results, cross-workspace data leakage via tool args, credential exfiltration via tool outputs.
- [ ] Document the test cases, results, and mitigations.

#### For field testing (ARIA Level 3)

- [ ] Deploy the engine to a pilot set of real AI-built apps.
- [ ] Collect interaction logs (redacted), failure modes, and impact data.
- [ ] Publish a field-test report.

### Codebase additions

- `packages/eval/ai-safety/` — adversarial prompt corpus, test runner, result emitter.
- `apps/worker/src/engine/ai-safety-runner.ts` — runs the safety suite against the engine in a sandboxed mode.
- `apps/marketing/src/pages/ai-safety.astro` — public methodology + results page.
- `docs/ai-safety/` — test plan, corpus description, model version pinning, reviewer sign-off.

### What can be said honestly today

- "Engine includes a prompt-injection guard for MCP tool calls" (true — `prompt-injection-guard.ts`).
- "Prompt-injection guard evaluated against the OWASP Gen AI Red Teaming Guide (42 test cases, 4 assessment areas) — 85.7% matched the declared outcome and expected detection patterns" — **RECORDED** (see `/ai-safety` and `apps/marketing/src/data/ai-safety-results.json`; rerunnable harness pending).
- "Prompt-injection guard run against the MLCommons AILuminate demo prompt set (292 prompts, 3 hazard categories) — 4.5% matched guard rules" — **DONE** as an observational scope check (see `/ai-safety`). The corpus supplies no prompt-injection oracle, so this is not a pass rate or safety score.
- "AI safety tested against [named framework]" — now defensible for OWASP and MLCommons AILuminate, with the bounded wording above. Not defensible for NIST ARIA (requires their evaluation) or ISO 42119-8 (standard not yet published).
- "AI safety tested" without qualification — **still not defensible**; it implies a formal evaluation by a third party. The current evaluation is first-party only.
- Two known guard bypasses documented: zero-width character concatenation and cross-script Unicode homoglyphs.

### Timeline and cost

- **First-party evaluation:** 5–10 weeks (build harness, run against MLCommons, publish).
- **Third-party evaluation:** 13–22 weeks (scheduling-dependent).
- **Cost:** $10k–$50k for a third-party red-team firm.

---

## Claim 5: "Adversarial robustness proven"

### What it means

This is the strongest AI-safety claim and the hardest to support. In the academic literature, "proven adversarial robustness" has a specific meaning: a **formal mathematical certificate** that a model's output cannot be changed by any adversarial perturbation within a defined norm bound (e.g., L2 < 0.5).

Relevant work:

- **Cohen et al. 2019** — Certified Adversarial Robustness via Randomized Smoothing (L2 bound). See <https://proceedings.mlr.press/v97/cohen19c.html>.
- **PROSAC** — provably safe certification with population-level risk guarantees. See <https://ojs.aaai.org/index.php/AAAI/article/view/32300>.
- **Formally verified robustness certifiers** (Dafny-verified implementations). See <https://doi.org/10.1007/978-3-031-98679-6_15>.
- **Tight certification of adversarially trained networks** via SDP relaxations. See <https://proceedings.mlr.press/v202/chiu23a/chiu23a.pdf>.
- **SoK: Certified Robustness for Deep Neural Networks**. See <https://doi.org/10.48550/arxiv.2009.04131>.

These apply to **classifiers with continuous input spaces** (vision models). For **LLM-based systems**, there is **no accepted formal certification of adversarial robustness**. The strongest claim you can make for an LLM system is:

> "Evaluated against [named adversarial benchmark] with [measured] attack success rate under [defined threat model]."

### What LyraShield would need to do

#### Threat model definition

- [ ] Name the attacker capabilities: black-box (prompt-only), gray-box (prompt + tool schema), white-box (prompt + model weights + system prompt).
- [ ] Name the attack classes: prompt injection, jailbreak, data exfiltration, tool-call override, cross-tenant leakage.
- [ ] Name the success criterion: did the engine emit a finding it should not have, suppress a finding it should have, leak workspace data, or execute an unapproved action?

#### Adversarial test corpus

- [ ] Use MLCommons AILuminate Jailbreak Benchmark v0.5 (text-to-text and text+image-to-text).
- [ ] Use HarmBench (18 red-teaming methods × 33 targets).
- [ ] Add LyraShield-specific attacks: scan-result prompt injection (a finding description that contains an instruction to the engine), cross-workspace target poisoning, MCP tool-call injection.

#### Evaluation harness

- [ ] Run each attack class against the engine under each threat model.
- [ ] Measure: attack success rate, refusal rate, false-finding rate, data-leakage rate.
- [ ] Run defenses: the existing `prompt-injection-guard.ts`, plus any new mitigations.
- [ ] Report: per-attack-class robustness score, with confidence intervals.

#### Independent verification

- [ ] Submit to NIST ARIA or MLCommons for third-party evaluation, OR
- [ ] Engage a third-party AI red-team firm (e.g., Haize Labs, Robust Intelligence, or an academic lab) to reproduce the results.

#### Formal claim (only if you go further)

- [ ] For the _deterministic_ parts of LyraShield (the regex guard, the RLS enforcement, the approval gate), you could in principle prove properties using formal methods (Dafny, F*, or TLA+). This is not "adversarial robustness of the AI" but "formal verification of the policy enforcement layer." That is a defensible, narrower claim.

### Codebase additions

- `packages/eval/adversarial/` — attack corpus, attack runner, defense evaluator.
- `packages/eval/adversarial/formal/` — formal verification of the policy enforcement layer (Dafny or TLA+ specs for RLS, approval gate, prompt-injection guard).
- `apps/marketing/src/pages/adversarial-evaluation.astro` — public results page with threat model, attack classes, scores, and independent reviewer.
- `docs/adversarial/` — threat model, test plan, results, reviewer sign-off.

### What can be said honestly today

- "Includes a prompt-injection guard for MCP tool calls" (true).
- "Evaluated against [named benchmark] with [measured] attack success rate" — only after the harness runs.
- "Adversarial robustness proven" — **never** for the LLM components; there is no accepted formal certification for LLM adversarial robustness. For the deterministic policy layer, "formally verified" is possible after the Dafny/TLA+ work is done.

### Timeline and cost

- **Build the adversarial eval harness:** 3–6 weeks.
- **Run against MLCommons + HarmBench + LyraShield-specific attacks:** 2–4 weeks.
- **Third-party reproduction:** 8–16 weeks (scheduling-dependent).
- **Formal verification of the policy layer (optional, narrower claim):** 8–16 weeks.
- **Total:** 13–40 weeks depending on depth and third-party availability.
- **Cost:** $20k–$100k for third-party + formal methods work.

---

## Summary table

| Claim                           | What it requires                                                                                                         | Timeline                                        | Cost (rough)                                     | Honest now?                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| "SOC 2 compliant"               | CPA-issued Type II report                                                                                                | 6–12 months                                     | $40k–$120k + internal work                       | No                                                                                      |
| "Certified" (ISO 27001)         | Accredited body certificate                                                                                              | 6–9 months                                      | $25k–$60k                                        | No                                                                                      |
| "Guarantees security"           | Bounded scope, eval corpus, liability cap, cyber E&O insurance                                                           | 3–6 months + legal                              | $5k–$25k/yr insurance + legal                    | No                                                                                      |
| "AI safety tested"              | Adversarial test harness + published results + independent review                                                        | 5–10 weeks first-party; 13–22 weeks third-party | $10k–$50k for third-party                        | **Partial** — OWASP + AILuminate first-party eval done; third-party review still needed |
| "Adversarial robustness proven" | Formal certification (impossible for LLMs today) OR formal verification of deterministic policy layer + adversarial eval | 13–40 weeks                                     | $20k–$100k for third-party + formal methods work | No                                                                                      |

---

## Recommended sequencing

1. **Recorded:** published the 2026-08-13 OWASP result (42 cases; 85.7% expected-outcome match) and AILuminate demo observation (292 prompts; 4.5% guard-rule match) on `/ai-safety`. Restore or replace the removed runner before claiming clean-checkout reproducibility.
2. **Next:** get independent review of the results (third-party red-team firm or academic lab). This upgrades from "first-party evaluated" to "independently reviewed."
3. **Months 2–6:** start the SOC 2 Type II observation window. Build the evidence automation and policy library. Engage a CPA firm.
4. **Months 3–6:** build the adversarial eval harness and run it. Publish results. This unlocks "evaluated against [benchmark] with [measured] attack success rate."
5. **Months 6–12:** complete SOC 2 Type II fieldwork and get the report. Only then say "SOC 2 Type II certified."
6. **Optional, months 6–18:** pursue ISO 27001 if enterprise customers demand it. Pursue formal verification of the policy layer if you want the narrower "formally verified" claim.
7. **Never:** say "guarantees security" or "adversarial robustness proven" for the LLM components. The former is a legal liability trap; the latter has no accepted meaning for LLMs.

---

## Ongoing guardrails

To keep prohibited claims out of the codebase:

- [ ] Add a CI check that greps `apps/marketing/src/pages` and `apps/marketing/src/content` for positive claim patterns: `is certified`, `is compliant`, `universal security`, `adversarial robustness`, `guarantees security`, `SOC 2 certified`, `ISO 27001 certified`, `AI safety tested` (without a following `against [framework]`).
- [ ] Make sample-report and handoff copy explicitly state they are examples of what _not_ to claim.
- [ ] Have a manual copy review before any indexable marketing deploy.
- [ ] Review this document quarterly or before any claim-changing release.

---

## References

- AICPA Trust Services Criteria: <https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2>
- NIST ARIA: <https://ai-challenges.nist.gov/aria>
- NIST AI 100-2e2025 (Adversarial Machine Learning): <https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-2e2025.pdf>
- MLCommons AILuminate: <https://mlcommons.org/benchmarks/ailuminate/>
- ISO/IEC AWI TS 42119-7 (AI red teaming): <https://www.iso.org/standard/91240.html>
- ISO/IEC AWI TS 42119-8 (GenAI quality assessment): <https://www.iso.org/standard/91609.html>
- OWASP Gen AI Security Project: <https://genai.owasp.org/initiative/red-teaming-evaluation/>
- HarmBench: <https://proceedings.mlr.press/v235/mazeika24a.html>
- UK AISI evaluations: <https://www.gov.uk/government/publications/ai-safety-institute-approach-to-evaluations>
- Cohen et al. 2019 (Certified Adversarial Robustness via Randomized Smoothing): <https://proceedings.mlr.press/v97/cohen19c.html>
- PROSAC: <https://ojs.aaai.org/index.php/AAAI/article/view/32300>
- SoK: Certified Robustness for Deep Neural Networks: <https://doi.org/10.48550/arxiv.2009.04131>
- _Royal Indem. Co. v. Security Guards, Inc._, 255 F. Supp. 2d 497 (E.D. Pa. 2003): <https://law.justia.com/cases/federal/district-courts/FSupp2/255/497/2562619/>
- _Jewels by Iroff, Inc. v. Securitas Tech. Corp._, 2023 U.S. Dist. LEXIS 172391
- _David Gutter Furs v. Jewelers Protection Services_, 1991
