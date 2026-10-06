# LyraShield AI — Whitepaper

## Version 1.1.0 — 2026-10-06

> The public product explanation for LyraShield AI: who it serves, what makes it different, how the assurance loop works and what its evidence can establish. The [litepaper](./litepaper.md) is the executive overview; the [yellowpaper](./yellowpaper.md) specifies the technical contracts. Executable source governs implementation; dated release evidence in [PRD.md](../PRD.md#8-current-production-evidence) governs deployment claims. This revision is a documentation review, not a new production acceptance.

## Contents

- [Abstract](#abstract)
- [1. The problem: the verification gap](#1-the-problem-the-verification-gap)
- [2. Product definition](#2-product-definition)
- [3. Product surface](#3-product-surface)
- [4. The evidence model](#4-the-evidence-model)
- [5. Assurance features](#5-assurance-features)
- [6. Distribution](#6-distribution)
- [7. Security and trust architecture](#7-security-and-trust-architecture-overview)
- [8. Commercial model](#8-commercial-model)
- [9. Claims and assurance boundary](#9-claims-and-assurance-boundary)
- [10. Roadmap](#10-roadmap)
- [11. Success measures](#11-success-measures)
- [12. Frequently asked questions](#12-frequently-asked-questions)
- [Appendix A — Methodology versioning](#appendix-a--methodology-versioning)
- [Appendix B — Glossary](#appendix-b--glossary)
- [Appendix C — Source and reading guide](#appendix-c--source-and-reading-guide)

## Abstract

AI-assisted development can shorten the path from an idea to working software. Working software still needs review: authorization boundaries, credentials, dependencies, model integrations and release identity do not become trustworthy merely because a demonstration succeeds.

LyraShield AI is an evidence-backed release-assurance product for AI-built software. It reviews an authorized target, retains what was assessed, separates detected risks from independently verified evidence and retest-confirmed outcomes, supports authorized fix proposals and packages the result into reviewable reports.

Its organizing principle is that a finding, a score, a completed scan and a security guarantee are different things. Coverage gaps and inconclusive results belong in the record, not outside it. The intended outcome is a better-informed release decision and a defensible handoff—not a claim that software is universally safe.

## 1. The problem: the verification gap

### 1.1 Working is not the same as ready

A generated application can pass its happy-path demonstration while leaving important questions unanswered:

- Can one user access another user's records?
- Did a privileged service key reach a client bundle?
- Are generated endpoints enforcing authentication and authorization?
- Is model output treated as untrusted before it reaches an interpreter?
- Can an agent tool make consequential changes outside its intended scope?
- Does the reviewed source match the release being handed to a customer?

These questions also apply to human-written software. LyraShield's specialization is the review workflow and failure catalog for AI-built applications, not a claim that AI-origin code has a measured universal failure rate.

### 1.2 Three gaps in a release decision

**Review capacity:** generating more changes can increase the work that needs review. A faster authoring loop does not itself produce security evidence.

**Context:** exposed credentials, permissive scaffolds, placeholder checks and broad integration scopes need to be interpreted together with the application boundary. A detected pattern is useful, but it does not automatically establish exploitability.

**Transferable assurance:** a client or engineering lead needs to know what was tested, what remains open, what changed and what a fresh retest established. A bare issue count does not answer those questions.

### 1.3 Detection and assurance are complementary

Point scanners, dependency tools, code review and authorized penetration tests can remain valuable inputs. LyraShield does not need to replace them to provide a useful assurance record.

The product connects detection to scope, evidence state, remediation and release identity. Third-party detections can be imported through supported SARIF workflows, but importing a detection does not establish LyraShield scanner coverage or independent verification.

The difference is the question being answered: not only “what was flagged?”, but “what can this retained assessment support?”

## 2. Product definition

LyraShield AI is an evidence-backed release-assurance product for AI-built software. It is not a certification service or a substitute for an authorized penetration test.

One organizing loop connects its surfaces:

```text
Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report
```

The product promise is to:

- connect an authorized repository, web app or API;
- record what was tested and what could not be tested;
- separate detected risks, retest-confirmed outcomes, independently verified findings and inconclusive results;
- explain risks in plain language while retaining technical evidence;
- support authorized fix proposals, server-owned retests and shareable assurance reports;
- keep the claim no broader than the retained evidence.

The loop is shared; hosted and local surfaces do not necessarily retain identical evidence artifacts or expose every capability.

### 2.0 What makes it different

Eight design choices organize the product's value proposition:

1. **Evidence states instead of confidence scores** (§4). Detection, deterministic retest validation and independent verification remain distinct. Confidence helps triage; it never manufactures proof.
2. **Coverage organized around AI-built failure patterns** (§5.4–5.6). The AI-Built Failure Taxonomy, AI App Security signals and WebMCP controls make agent and model boundaries explicit review subjects.
3. **Agent-native distribution** (§6). The CLI, 21-tool MCP catalog, portable Agent Plugin and account-less GitHub Action bring the workflow into editors, terminals and CI.
4. **An authorization-bound fix loop** (§3.4). Patches are server-owned and scope-checked; browser requests require approval, while authorized credential paths use their separate permission boundary. Nothing auto-merges. Eligible merged fix PRs initiate fresh retests.
5. **A versioned verdict and verifiable report** (§5.2–5.3). Launch Gate decisions, report integrity and optional release-identity confirmation answer separate, reviewable questions.
6. **Honest coverage accounting** (§5.1). Per-control receipts disclose incomplete and evidence-required work. “No finding” is not renamed “passed.”
7. **Two modes, one product loop** (§2.1). Hosted Cloud and BYOK Local/Desktop give different execution and commercial choices without redefining evidence language.
8. **Fail-closed trust boundaries** (§7). Tenant isolation, bounded untrusted engine output and provenance-bound manifests prevent missing authority or evidence from becoming a positive claim.

These are product design properties, not claims of market exclusivity, measured superiority or guaranteed detection. The public claims policy in §9 governs each one.

### 2.1 Two modes, one account

| Mode          | Execution                          | Commercial model                                            | Model credentials and cost                                         |
| ------------- | ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Cloud         | Hosted application and worker      | Subscription and agent-minute allowances                    | LyraShield supplies the configured provider route                  |
| Local/Desktop | Customer machine and local sandbox | BYOK license with update eligibility and perpetual fallback | Customer supplies supported AI credentials and pays their provider |

Local execution is not the same as offline inference. Supported BYOK scans can send selected context to the customer's chosen AI provider; licensing, updates and optional Cloud Sync also have network paths. No LyraShield model key is embedded in the desktop app.

Cloud Sync is explicit opt-in. Selected findings and bounded reports can move into the Cloud workspace; the raw provider credential is not a sync artifact. Local findings remain unverified observations rather than acquiring hosted verification merely by being uploaded.

The Desktop implementation exists in source. Signed public distribution and production purchase availability remain separate release gates; readers should not infer download availability from the licensing design.

### 2.2 Who it serves

Phase 1 focuses on builders, founders, developers, small SaaS teams and agencies. Enterprise governance is roadmap work, not an implied feature of an Enterprise price label.

| Audience            | Release question                                    | Useful output                                                       |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| Solo builder        | What needs attention before launch?                 | Findings with explanations, coverage limits and next actions        |
| SaaS team           | Does this change leave unresolved release blockers? | PR review, retest record and target-specific gate state             |
| Agency              | What can we substantiate at client handoff?         | A bounded report, disclosed limitations and release-reference check |
| Technical evaluator | How is this assurance claim constructed?            | Versioned methodology, evidence contracts and source references     |

### 2.3 Audience journeys

#### Solo builder: review before a public launch

Connect an authorized target, select the least intensive review that answers the question and read findings alongside coverage. A missing family receipt or capped source collection is a reason to investigate, not a reason to rely on a high score.

The useful result is an ordered remediation list and an assessment record. The builder still decides whether remaining operational risks are acceptable.

#### SaaS team: review a change, then retest

Use local diff checks as a pre-filter, then a recorded PR or repository review when durable evidence is needed. Track the source revision, review server-generated patch proposals and queue a fresh retest after applying changes.

A merge is a code event. A validated retest is an evidence event. The team should not treat them as interchangeable.

#### Agency: hand over an explainable assessment

Use the assessment to explain checked scope, unresolved findings, documented dispositions and retest outcomes. Generate an appropriate report and share it through the intended revocable channel.

If the client needs to know whether a particular commit or artifact was assessed, use the identity-checking workflow. A signed report alone does not prove that the client's deployed application is that release.

#### Technical evaluator: inspect the method before relying on it

Review the gate standard, score calculation, manifest integrity contract and public disclosure policy. Distinguish source tests from retained provider/runtime acceptance.

Use the yellowpaper to evaluate integration and evidence mechanics; use the release-status owner to evaluate availability.

## 3. Product surface

The authenticated product is described as open beta with open registration at [app.lyrashieldai.com/sign-up](https://app.lyrashieldai.com/sign-up). Registration, individual feature admission, operational readiness and commercial acceptance are separate states.

### 3.1 Cloud application

The implemented Cloud surface includes:

- identity and configured OAuth providers, workspaces, memberships, projects and targets;
- scan preflight, admission, queueing, cancellation, lifecycle events and schedules;
- normalized findings, coverage receipts, result manifests, retests and notifications;
- fix proposals and server-generated fix PRs under the applicable authorization boundary;
- private scores, opt-in public scorecards and creation-time report snapshots;
- CLI, SDK, MCP/OAuth and agent integration support;
- billing, entitlements, usage, minute packs, grace and bounded overage;
- an affiliate application and ledger with separate payout-operation gates;
- scan attachments and change-review workflows;
- a feature-flagged Myra support agent and gated API-level connectors.

The adaptive dashboard presents next actions and progressively reveals technical depth. Presentation does not change permission, scan scope or verification semantics.

Configured sign-in providers and feature flags determine what appears in a deployment. A source implementation list is not a blanket statement that all features are enabled publicly.

### 3.2 Local/Desktop

The Tauri application combines a Rust core, React interface, local engine process and container sandbox.

Its source implements signed-license verification, supported BYOK configuration, local scan storage, user-confirmed updates and optional authenticated sync.

Update eligibility and scan eligibility are separate. Expired update eligibility allows continued use of an eligible installed build or the signed fallback build, subject to license validity, revocation and periodic online verification. It does not promise an indefinitely disconnected installation.

Following successful server verification, the license design allows seven rolling days of offline grace. That licensing grace does not remove the network needs of the AI provider, scans, updates or sync.

### 3.3 Marketing and free tools

The public site at [lyrashieldai.com](https://lyrashieldai.com) provides methodology, technical content and integration guides.

**Lite Check** at [the public scan page](https://lyrashieldai.com/scan) is a passive, outside-in public-page review. It reads the submitted page, headers and at most six linked same-origin JS/CSS assets. It does not authenticate, exploit, enumerate private paths or actively test database RLS.

The six browser-local utilities are:

1. AI app launch checklist.
2. Headers and CORS review helper.
3. Secret exposure scanner.
4. Supabase RLS review helper.
5. JWT/session inspector.
6. AI App Security scanner.

Their supplied analysis inputs stay in the browser. They do not create the hosted full-scan evidence record or an official LyraShield Score.

### 3.4 Illustrative release-assurance walkthrough

The following is a fictional staging scenario explaining the workflow. It is not a customer case study, an accepted production scan or a promise of detection.

#### Step 1 — Establish authorized scope

A builder connects a repository they are permitted to review and records the intended environment. They select a Standard review for a source-aware release assessment.

For an engine-backed live URL/API assessment, additional domain verification and bounded relay authorization are required; a repository authorization does not authorize attacks on unrelated live systems.

#### Step 2 — Review admission and run

Preflight reports whether the work would currently be admitted. The server checks again when the scan is submitted: membership, credentials, target scope, entitlements, limits and worker readiness still apply.

If admission is unavailable, there is no completed assessment to rely on. A successful preflight is advisory, not a reservation of capacity.

#### Step 3 — Interpret the findings and coverage

Suppose the hypothetical assessment retains a detected credential-handling issue and an inconclusive model-output concern. The builder sees both together with scanner-family and per-control scope.

The credential-handling candidate is still detected unless independent verification exists. The inconclusive concern is not converted into a clean result merely because the engine stopped discussing it.

#### Step 4 — Choose a remediation path

The builder can apply a change themselves and request a retest, or inspect a fix proposal whose server-generated patch passes scope validation.

A browser fix PR request binds the exact patch to human approval. A permitted API-key or delegated OAuth path uses the tighter execution permission and its credential/grant controls. Neither path accepts a caller-authored privileged patch, and neither auto-merges.

#### Step 5 — Merge and initiate a fresh retest

When a recognized fix PR merges, loop-closure handling can create and enqueue a new retest scan. It remains subject to admission, available minutes, target serialization and queue recovery.

The retest is not the original terminal scan. If it cannot run or cannot establish complete originating coverage and identity, the finding does not become proven fixed.

#### Step 6 — Evaluate the release and report

A clean deterministic retest can produce a retest-confirmed outcome within its supported scope. Engine-only absence remains inconclusive without independent evidence.

The gate evaluates retained evidence, while applicability checks whether that assessment can still describe the requested release. An expired assessment or changed policy prevents reuse as current assurance.

The builder then issues a report, checks whether it is signed and shares the appropriate artifact. The recipient reads non-coverage and freshness as carefully as the verdict.

### 3.5 Monitoring is a new observation, not a permanent guarantee

Schedules initiate recurring reviews under the applicable admission and authorization rules. A previous completed run does not establish the next run's coverage or outcome.

A failed, partial or skipped opportunity to assess should be visible. Monitoring cadence is useful operational context; it does not certify every change between assessments.

## 4. The evidence model

Evidence discipline is the product's organizing rule. Four different dimensions must remain separate.

### 4.1 Evidence states

| State                             | Meaning                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `DETECTED`                        | A scanner reported a candidate with retained provenance                                                               |
| `VALIDATED`                       | A server-owned deterministic retest established absence of the originating condition within complete supported scope  |
| `VERIFIED`                        | Independent trusted verification evidence exists                                                                      |
| `INCONCLUSIVE`                    | Available coverage or evidence cannot support a reliable conclusion                                                   |
| `NOT_ASSESSED` / `NOT_APPLICABLE` | A control was not evaluated or does not apply; these are coverage-context labels, not successful finding verification |

A candidate does not need to progress through all these states in a fixed sequence. Independent verification and deterministic retest validation answer different questions.

### 4.2 Result integrity rules

Engine output is untrusted and bounded. Candidates, coverage receipts, findings and result manifests retain the provenance needed to interpret it.

Manifest integrity binds the result to execution identity. New-format rows retain the exact checksum input; legacy rows without it remain integrity-unavailable rather than being rewritten to appear verifiable.

Retest validation requires stored original and retest evidence, supported identity and complete deterministic coverage. Repository revisions can differ after a fix; missing identity remains inconclusive. The recorded production audit still identifies a checksum-match gate gap—see §9.3 rather than assuming source requirements prove deployed enforcement.

Evidence uploads require checksum and encryption metadata. Direct status changes cannot manufacture a trusted terminal fix; `FIXED_PENDING_RETEST` preserves the need for new evidence.

Idempotency is part of the safety design. Inspect an uncertain operation before retrying; changing the key can request genuinely new work.

### 4.3 Four dimensions of one result

| Dimension         | Example      | What it does not prove                 |
| ----------------- | ------------ | -------------------------------------- |
| Scan execution    | `COMPLETED`  | No vulnerabilities exist               |
| Finding lifecycle | `PR_OPENED`  | The patch merged or the issue resolved |
| Verification tier | `DETECTED`   | Independent confirmation               |
| Control coverage  | `NO_FINDING` | Every application path is safe         |

A completed scanner can return an inconclusive control result. A proposed fix can coexist with an unresolved finding. A high score can coexist with insufficient gate evidence.

### 4.4 Coverage, uncertainty and dispositions

Coverage receipts describe the assigned observation, supported scope and limitations. Capped file discovery, unreadable files, timeouts and missing receipts matter because absence of a finding is meaningful only within what was actually examined.

Model-declared scope metadata helps explain an engine's work but is not independent coverage measurement. It cannot satisfy the deterministic coverage gate by itself.

Accepted risk and false-positive dispositions are human decisions with a reason and audit trail. Where the gate uses a disposition, it must be applicable to that assessment. Neither disposition is independent technical verification.

### 4.5 What a recipient should ask

1. What target and release does the assessment cover?
2. Which methodology and scanner families were used?
3. Which controls were incomplete or evidence-required?
4. Which findings are detected, validated, verified or inconclusive?
5. Which resolutions came from a retest, and which are recorded dispositions?
6. Is the assessment still applicable, and is the share capability live?
7. What operational proof remains outside the scan?

## 5. Assurance features

### 5.1 Vibe Security 50

`vibe-security-50/1.2.0` is a versioned catalog of 50 controls. It organizes review; it is not 50 independent security guarantees.

| Strategy          | Controls | Interpretation                                              |
| ----------------- | -------: | ----------------------------------------------------------- |
| Deterministic     |        5 | Bounded repeatable observations                             |
| Hybrid            |       11 | Deterministic signals plus context; absence remains limited |
| Engine-led        |       27 | Review that needs source, interaction or business context   |
| Evidence-required |        7 | Deployment, process or human proof a scan cannot establish  |

The coverage ledger reports assigned outcomes rather than treating an unreported control as passed. `NO_FINDING`, `INCONCLUSIVE`, `NOT_APPLICABLE` and `EVIDENCE_REQUIRED` remain visible.

A repository's inclusion of bounded IaC checks does not mean standalone cloud-account, container or IaC targets are released. Control mappings do not imply every profile examines every class.

### 5.2 Launch Gate

`lyrashield-gate/2.3.0` evaluates stored assessment evidence into:

- **READY:** the implemented evidence rules are satisfied for the assessed scope.
- **NOT_READY:** an unresolved Critical or High blocker remains after applicable resolution/disposition checks.
- **INSUFFICIENT_EVIDENCE:** target coverage, identity, receipts or supporting evidence are inadequate for a positive decision.

Coverage and identity sufficiency take precedence over readiness. The gate also requires scoped positive evidence or an applicable disposition for unresolved findings that would otherwise make READY unsupported. Medium/Low are not direct blocking severities, but their evidentiary state can still prevent a positive result.

Historical verdicts are immutable. Applicability is evaluated separately: the assessment expires after 24 hours, and changed identity, policy, newer attempts or evidence drift can make its effective state insufficient.

The CLI verdict gate exits `0` for READY, `1` for NOT_READY and `2` for insufficient evidence or error. This is distinct from the local severity/diff gate.

### 5.3 Launch Readiness Report

The report is the shareable form of an assessment, with an allowlisted frozen payload, explicit coverage/non-coverage and aggregate outcomes.

When the deployment has a signing key, it signs the report checksum with ed25519. The source also supports unsigned issuance; a recipient must check the signing state rather than assuming every report is signed.

Signature verification establishes the presented checksum's relationship to LyraShield's configured signing key. To establish document integrity, the checksum must also correspond to the actual presented payload. A valid signature is not verification of every finding, a certificate or a live deployment check.

Optional release confirmation requires the report's live share token plus a caller-supplied full commit or artifact digest. It returns only:

- `MATCH`: the supplied identity agrees with the private retained binding;
- `MISMATCH`: a comparable identity differs;
- `UNAVAILABLE`: the capability, report, provenance, kind or checksum cannot support confirmation.

It never returns the stored identity. A match can coexist with a stale report or a not-ready verdict.

Shares are revocable and normally expire after 30 days. That sharing window is not the gate's 24-hour assessment-validity window. Historical signed bytes remain historical even when their signature is still cryptographically valid.

Medium/Low public report counts are disclosed as not directly gate-evaluated rather than silently rendered as zero. Private technical reports and public aggregate launch reports have different disclosure scopes.

### 5.4 AI-Built Failure Taxonomy

`ai-built-failure-taxonomy/1.0.0` names eight characteristic review classes, exposed read-only at `/api/taxonomy/ai-built-failures`.

The mechanisms below are review hypotheses encoded in the catalog, not measured prevalence claims. Scanner mappings indicate where a class is reviewed; they do not prove complete detection in every target/profile.

#### AIB-01 — Service keys exposed in client bundles

A privileged database or server credential is shipped in browser-visible code. A working integration can conceal the server/client trust-boundary error.

Mapped surfaces: secrets, URL and repository IaC review. Control: `vibe-03`. Catalog severity: Critical.

Review must distinguish privileged credentials from intentionally public configuration. Detecting a key-shaped value alone does not establish that it is active or exploitable.

#### AIB-02 — Missing auth on generated endpoints

A route or action answers its happy-path request without enforcing caller identity or authorization. The endpoint's existence is not evidence that its access boundary was reviewed.

Mapped surfaces: engine, SAST and URL review. Controls: `vibe-04`, `vibe-05`. Catalog severity: Critical.

Public surface checks cannot prove all authenticated authorization paths; source and authorized test context may be necessary.

#### AIB-03 — Permissive row-level security left in place

RLS is enabled, but policy conditions grant more access than intended. The “RLS on” label can look reassuring while failing the tenancy requirement.

Mapped surfaces: engine and SAST review. Control: `vibe-02`. Catalog severity: High.

A configuration signal or local helper is not a two-user runtime isolation test or proof of the deployed database role.

#### AIB-04 — Over-broad API and tool scopes

Tokens, service accounts or agent tools receive permissions beyond the task. A broad grant can make a demonstration work while expanding the consequences of mistakes.

Mapped surfaces: agent configuration, AI App Security and repository IaC review. Controls: `vibe-42`, `WEBMCP-04`, `vibe-44`. Catalog severity: High.

A policy annotation is not an enforcement boundary. Review actual authorization and runtime behavior separately.

#### AIB-05 — Secrets inside agent tool definitions

Credentials are embedded in tool definitions, prompts or schemas, exposing material to readers or model context that does not need it.

Mapped surfaces: agent configuration, secrets and WebMCP review. Control: `vibe-40`. Catalog severity: High.

An empty caller-supplied credential field is not the same as an embedded credential. Context and false-positive guards matter.

#### AIB-06 — Unvalidated model output flows into queries or commands

Model-generated text is sent into an interpreter without validation, encoding or parameterization. The model response is mistaken for trusted structured input.

Mapped surfaces: engine and SAST review. Controls: `vibe-11`, `vibe-19`. Catalog severity: High.

Static pattern evidence does not establish all runtime data-flow paths. Unsupported syntax or incomplete source scope must remain disclosed.

#### AIB-07 — Placeholder logic that ships as if real

A security-relevant stub returns success, a tautological check passes or incomplete logic retains a production-looking interface.

Mapped surfaces: engine and SAST review. Control: `vibe-49`. Catalog severity: Medium.

Intentional test scaffolding and deployed application behavior are different contexts; a reviewer must determine which the assessment describes.

#### AIB-08 — Dependency pulled in without vetting

A plausible package choice is added without validating identity, maintenance, resolved version or installation behavior.

Mapped surfaces: SCA and repository IaC review. Controls: `vibe-37`, `vibe-39`, `vibe-38`. Catalog severity: Medium.

Known-advisory coverage is not proof that a package is benign. Missing or stale advisory evidence must not be treated as a clean dependency result.

### 5.5 WebMCP Assurance

Fourteen controls review browser-registered agent tools: annotation/behavior mismatch, untrusted content, cross-origin exposure, permissions, durable mutations, schemas, cancellation, lifecycle cleanup, embedded secrets, injection surfaces, spec drift and contract budgets.

The shared static analyzer supports the browser-local Security Lab, bounded repository analysis, CLI diff workflows and a guarded Action subset. The subset is not the entire catalog executed against the whole repository.

The opt-in [runtime checker](./webmcp-runtime.md) observes authorized fixture behavior separately. One browser observation never silently upgrades a static finding into independent verification or establishes behavior across every client.

Dashboard WebMCP preparation tools can fill a form without starting a scan. This is separate from delegated hosted MCP workflows that can authorize paid operations.

### 5.6 AI App Security

The catalog contains eight signals, seven static/deterministic and one dependency/advisory strategy:

| Signal | Review subject                            | OWASP LLM mapping |
| ------ | ----------------------------------------- | ----------------- |
| AI-01  | Missing prompt-injection input validation | LLM01:2025        |
| AI-02  | Sensitive data in model context           | LLM02:2025        |
| AI-03  | AI library supply chain                   | LLM03:2025        |
| AI-04  | Model output in dangerous sinks           | LLM05:2025        |
| AI-05  | Unbounded agent permissions               | LLM06:2025        |
| AI-06  | System prompt exposed to the client       | LLM07:2025        |
| AI-07  | Unauthenticated vector/RAG access         | LLM08:2025        |
| AI-08  | Missing model-consumption limits          | LLM10:2025        |

The browser-local utility runs AI-01, AI-02 and AI-04–AI-08 without uploading source. Hosted repository checks add supported dependency/advisory context and private evidence persistence. File/byte/time caps are part of the result, not hidden implementation detail.

The private AI App Security score is separate from the general LyraShield Score and public scorecard. Optional triage code or feature flags do not establish released production triage/calibration acceptance.

The fixed live safety catalog is another capability: authorized non-production endpoint checks with explicit bounds. It is not arbitrary fuzzing or proof of adversarial robustness.

### 5.7 Lite Check and scorecards

Lite Check results are outside-in observations, not official scores. Public Lite cards carry aggregate information without target or vulnerability detail.

Authenticated scorecards use a separate disclosure constructor. Their payload contains grade, scope, date, methodology, resolved-finding count and a score-derived release label. `GO`, `GO_WITH_CONDITIONS` and `NO_GO` on that surface are not the evidence-based Launch Gate's READY/NOT_READY states.

Sharing is opt-in, permission-controlled, revocable and subject to eligibility. Public grade artwork must not be interpreted as a technical report or a release-identity attestation.

### 5.8 LyraShield Score methodology

`lyrashield-score/1.0.0` starts at 100 and subtracts weighted contributions from eligible open or accepted-risk findings.

| Severity | Base deduction |
| -------- | -------------: |
| Critical |             25 |
| High     |             10 |
| Medium   |              4 |
| Low      |              1 |
| Info     |              0 |

Independent verification uses multiplier 1; an unverified finding uses 0.25. Accepted risk multiplies the contribution by another 0.5. The score is rounded half-up and floored at zero.

This weighting is a prioritization heuristic. It does not assign a calibrated probability that a finding is real or that the application is safe.

| Numeric band | Initial grade |
| ------------ | ------------- |
| 98–100       | A+            |
| 90–97        | A             |
| 80–89        | B             |
| 65–79        | C             |
| 50–64        | D             |
| 0–49         | F             |

Grade caps prevent favorable arithmetic from hiding particular conditions:

- open Medium-or-higher findings prevent A+;
- an open independently verified Critical caps the grade at C;
- an open independently verified High caps it at B;
- an active open verified secret caps it at D.

The cap changes the grade, not the numeric score. Retest-validated and independently verified are distinct; a validated finding's resolved lifecycle, rather than renaming it independently verified, removes it from eligible open contributions.

#### Illustrative arithmetic

These examples exercise only the score function, not gate coverage or production findings:

| Inputs                                      |        Deduction | Score | Final grade                         |
| ------------------------------------------- | ---------------: | ----: | ----------------------------------- |
| One unverified open High                    |  10 × 0.25 = 2.5 |    98 | A, because an open High prevents A+ |
| One verified open High                      |      10 × 1 = 10 |    90 | B, because of the verified-High cap |
| One verified open Critical                  |      25 × 1 = 25 |    75 | C                                   |
| One verified accepted-risk High             | 10 × 1 × 0.5 = 5 |    95 | A                                   |
| One verified open High marked active secret |               10 |    90 | D, because of the secret cap        |

Service-level snapshot/share eligibility adds requirements beyond the pure arithmetic: applicable completed scanner-family receipts, supported review mode and bounded disposition ratio. The pure default-branch input is not, by itself, provider-backed proof that every ref-scoped scan covered a default branch.

A score can be high while the gate is NOT_READY or INSUFFICIENT_EVIDENCE. Never substitute a grade threshold for a gate evaluation.

### 5.9 Scan quality: facts before estimates

`lyrashield-scan-quality/1.0.0` projects stored evidence into counts and explicitly labeled estimates.

Facts include finding verification mix, receipt counts/statuses, manifest presence and ingestion warnings. Ratios such as assessed-receipt ratio and verified-finding ratio state their basis and limitations.

Neither ratio is detection accuracy, a false-negative estimate or adversarial robustness. A scan with zero findings is not proven accurate merely because its presentation is complete.

The parity contract discloses which clients measure, derive or do not report each field. Desktop does not pretend to retain the hosted manifest/receipt model.

## 6. Distribution

| Surface              | Role                                                                           |
| -------------------- | ------------------------------------------------------------------------------ |
| `lyrashield` CLI     | Setup, local pre-filters, recorded scans, findings, reports and gate workflows |
| `@lyrashield/mcp`    | 21 tools over stdio and hosted Streamable HTTP                                 |
| Agent workflows      | 51 registry entries resolving to 48 preferred client surfaces                  |
| GitHub Action        | Account-less, diff-aware local gate with SARIF                                 |
| Public API `/api/v1` | Versioned integration contract with the documented deprecation policy          |

### 6.1 Editor and agent workflows

A developer can inspect findings, request a remediation plan, run an admitted review and follow a retest without treating the editor as the authority for verification.

Local stdio can reuse the CLI's private OAuth credential store. Hosted clients use their remote OAuth connection. Workspace API keys remain a scoped CI/headless fallback, not a reason to place secrets in shared project configuration.

A writable hosted OAuth connection discloses its authorized operations, targets, profiles and possible usage charges. Matching calls can execute without another LyraShield prompt; the server rechecks the grant and membership at execution.

### 6.2 Local checks versus recorded reviews

`check-diff` is a local advisory pre-filter. It evaluates supplied changes and supported snapshots, not the entire application.

The local severity gate and account-less Action can block CI on supported risky patterns. They do not create a full provider-backed assurance record, and Action SAFE/AGGRESSIVE modes are not hosted Deep review.

Recorded scans retain target identity, lifecycle and coverage evidence. The single-target `gate --verdict` reads the versioned evidence decision rather than substituting a local pattern check.

### 6.3 Compatibility is not acceptance

The registry count includes distinct editor, CLI, desktop, web and cloud surfaces when their setup contracts differ. It is not 48 equally verified integrations or 48 public marketplace listings.

Package conformance, successful installation, tool discovery, authenticated workspace reads and authorized workflow execution require different evidence.

Use the [client guides](https://lyrashieldai.com/docs/integrations) and [distribution ledger](./marketplace/channels.md) for the current supported path. Published packages do not establish that an immutable vendor marketplace release is available.

## 7. Security and trust architecture (overview)

### 7.1 Tenancy and authority

Workspace membership and permissions are enforced by the application; explicit workspace scoping and database RLS provide separate data boundaries. Production runtime roles must not bypass RLS.

Administrative roles remain distinct from ordinary product operation. Legacy role names alone do not imply read-only access: current operational permissions are granted to active members, while billing, membership, policy and integration administration retain specific restrictions.

Platform administration is a separate browser/TOTP-controlled boundary, not a tenant Owner/Admin privilege or an API-key scope.

### 7.2 Execution and network limits

Repository review uses isolated execution with resource limits and controlled egress. URL inputs are validated, DNS-pinned and rechecked across redirects.

Engine-backed URL/API profiles require target verification and a scan-scoped relay. Scope controls are enforced outside model instructions; model willingness to follow a rule is not the boundary.

Limits can stop work. Preserved partial findings and their coverage gaps are more honest than converting a truncated run into a completed clean assessment.

### 7.3 Evidence and privacy

Evidence artifacts are private, encrypted, checksum-bound and workspace-scoped. Engine output remains untrusted even after storage.

Public scorecards and aggregate launch reports have separate allowlists. Private report provenance, source paths, target identity and raw evidence are not automatically part of public sharing.

Cloud review uses configured hosted AI providers. Local review uses the customer's supported BYOK route. “Local” describes execution and storage ownership, not an assurance that model context never leaves the machine.

Browser-local analysis inputs remain local; optional analytics and error reporting follow their separate allowlists and consent controls. No replay or raw analysis input is needed to measure coarse product events.

### 7.4 What the architecture does not establish

Source-level isolation controls do not prove every production role was configured correctly. A signed license does not protect a compromised endpoint, and a signed report does not validate the assessed software.

Backup/restore testing, provider delivery, worker identity and tenant runtime checks need exact, dated operational evidence. None should be inferred solely from the architecture diagram.

## 8. Commercial model

Two product lines use target limits and agent-minute allowances. Payment rails are region-resolved; published prices, checkout admission and proven financial operation remain separate.

### 8.1 Cloud plans

**Scan — find what needs attention:**

| Plan    |       Monthly | Annual | Agent-minutes | Targets | Deep |
| ------- | ------------: | -----: | ------------- | ------: | ---- |
| Trial   | $0 for 7 days |      — | 60 one-time   |       3 | No   |
| Starter |           $29 |   $295 | 210/month     |       5 | No   |
| Pro     |           $99 |   $950 | 850/month     |      15 | Yes  |

**Agency — team assurance and handoff:**

| Plan       |     Monthly | Annual | Agent-minutes | Targets | Purchase                         |
| ---------- | ----------: | -----: | ------------- | ------- | -------------------------------- |
| Agency     |        $499 | $4,188 | 4,500/month   | 50      | Self-serve, subject to admission |
| Enterprise | From $1,500 |      — | Custom        | Custom  | Contact-led                      |

Deep/Custom use a 3× minute multiplier. Failed scans are not billed under the recorded terminal-billing policy; user cancellations charge observed engine-backed elapsed time without a one-minute floor. Deterministic-only and pre-provider failures do not consume agent-minutes. Partial/budget outcomes require their actual terminal disposition; do not infer their billing from a label alone.

Minute packs are 100/$15, 250/$35 and 500/$65, valid for 180 days. Draw order is the monthly allowance, oldest valid pack, then permitted overage.

Agency overage is $0.15/minute behind a user-set spend limit. At most 15 minutes of non-bankable mid-scan grace can apply; a scan starting at zero is rejected.

Subscriptions and balances belong to the account, not the workspace. An Agency-sponsored workspace allows up to five members, including the buyer, to draw from the persisted sponsor's pool. Work outside that workspace uses the applicable scanner account.

Annual subscriptions replenish the monthly allowance each cycle; annual payment does not create a year's minutes in a single immediately spendable pool.

Repository connections, evidence/retest/report capabilities and agent access remain subject to permission and admission, rather than being universally reserved for the most expensive tier. Scope and capacity limits still differ.

Cloud purchases are non-refundable except where required by law or for duplicate collection, unauthorized payment or confirmed payment error. Exact terms and current provider availability govern checkout.

### 8.2 Local/Desktop licenses

| SKU               | Public schedule                        | Scope                                                                       |
| ----------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| Individual        | $199 launch / $299 regular one-time    | Up to three machines; one year of update eligibility and perpetual fallback |
| Team perpetual    | $99/seat one-time, minimum three seats | One year of updates and license management                                  |
| Team subscription | $149/seat/year                         | Subscription update terms                                                   |
| Cloud Sync add-on | $49/seat/year                          | Optional synchronization to an entitled Cloud workspace                     |

Update renewal is $59/seat/year; the team schedule includes 10% off at 10+ seats. There is no unlimited lifetime-update promise.

Fallback keeps eligible software usable, subject to license verification and revocation; it does not guarantee future provider compatibility, future updates or an unsigned release download.

### 8.3 Affiliate program

The application-gated schedule is 25% recurring for 12 months on Cloud monthly subscriptions, increasing to 30% at 10+ active referrals. Cloud annual commissions remain flat 25%; Local commissions are 20% one-time.

There is no commission on trials, packs or self-referrals. Promo code takes precedence over the 60-day last-click attribution path.

The operating model includes a $100 threshold, monthly net-30 payment on the 15th, a 30-day hold, tax-form gate and a 25% reserve during a new affiliate's first 90 days. Provider-confirmed reversals can claw back commissions.

Payout provisioning and tax operations remain separately gated. The ledger is not proof that every payout rail is available or a payout occurred.

### 8.4 Funnel

Lite Check, browser-local tools, the account-less Action and technical content provide bounded free value. The Cloud trial is time-limited; there is no permanent free full-product plan.

Product-updates email subscription is optional, not an invitation gate. Registration is open independently of that subscription.

The published commercial schedule was approved on 2026-09-22. This documentation does not authorize live charges, cancellation/refund tests or payout operations.

## 9. Claims and assurance boundary

The governing principle is **evidence-backed, scope-bounded and limitation-aware**. The [public claims policy](./policies.md#public-claims-policy) owns the review obligation.

### 9.1 What readers may infer

- A retained detection was reported within the documented observation scope.
- A retest-confirmed result has supported deterministic evidence for that retest condition.
- Independent verification requires independent trusted evidence, not confidence.
- A gate verdict describes its versioned assessment; applicability controls reuse.
- A signed report can support integrity checks for the bound payload/checksum.
- Public sharing excludes private details according to the relevant constructor.

### 9.2 What readers must not infer

| Statement                                             | Boundary                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| “The app is guaranteed secure”                        | No universal security guarantee is made                                               |
| “This report certifies SOC 2, ISO or GDPR compliance” | Reports are evidence summaries, not external attestations or legal determinations     |
| “Every finding is independently verified”             | Detected, validated and inconclusive results remain distinct                          |
| “The grade is the release gate”                       | Score math and evidence-based gate rules are different                                |
| “A matching report proves the deployed application”   | Identity confirmation compares the supplied reference; it does not inspect deployment |
| “A runtime fixture pass proves all client behavior”   | It establishes one bounded observation only                                           |
| “Published packages mean all marketplaces are live”   | Publication and client/runtime acceptance need separate receipts                      |

Certification or attestation language requires the issued external evidence for its scope and period. Any guarantee-shaped claim needs qualified legal review, defined obligations and applicable contractual terms; a reproducible corpus alone is not a guarantee.

### 9.3 Implementation versus release evidence

The current record distinguishes source implementation, package publication, deployment/readiness and bounded provider/runtime acceptance. None replaces the others.

The retained Standard acceptance is target- and revision-scoped, with zero independently verified findings. It is not a finding-accuracy benchmark or acceptance of every later revision/profile.

Recorded open gates include billing reconciliation/provider operations, exact-release scan/client acceptance, signed Desktop distribution and broader operational capacity/recovery evidence.

The recorded deployed retest audit identified missing enforcement of checksum MATCH for both manifests. Source remedies and exact deployment/runtime verification must be tracked separately. This paper does not claim the gap is closed or that any historical production result was proven incorrect.

Consult [PRD release status](../PRD.md#9-release-status) before reusing operational claims. This documentation revision performs no live scan or financial action.

### 9.4 Historical evaluation is not the live safety catalog

The public 2026-08-13 artifact records 42 OWASP cases with 36 matching declared outcomes (85.7%). A separate AILuminate demo observation records 13 guard matches across 292 prompts (4.5%); that number is not a pass rate or model-safety score.

Both are first-party observations, not independent evaluations. The historical runner was removed, so clean-checkout reproduction requires a replacement. The current fixed live safety catalog is a different authorized-endpoint contract.

No general detection accuracy, benchmark superiority or adversarial-robustness claim follows from these numbers.

## 10. Roadmap

Phase 2 direction proceeds only after relevant launch gates close and design-partner interviews validate demand.

- **Pilot:** enterprise OIDC, role management, workspace policy, an outbound-only private worker, audit export and evidence retention, evaluated with design partners.
- **Productized demand:** SCIM, SAML where required, customer-managed evidence storage/keys, retention/deletion controls and evidence mappings without certification claims.
- **Requested integrations:** signed outbound workflows and enterprise connectors selected for actual customer requirements rather than a speculative catalog.
- **Expansion choice:** customer VPC, self-hosted, MSP/MSSP operations or deeper scanner coverage, selected on validated demand.

SSO/SCIM, data residency, private workers and full self-hosting are not implied current features. Local/self-hosted models, standalone cloud/container/IaC targets and a human-validated pentest add-on remain deferred.

Bounded repository IaC analysis is distinct from the standalone target roadmap. The [Phase 2 archive](./Phase2.md) retains dated planning context; current implementation and release evidence remain owned elsewhere.

## 11. Success measures

Useful measures evaluate whether the assurance workflow is usable and evidence-complete, not whether marketing language sounds confident.

| Area        | Example measure                                         | Interpretation limit                      |
| ----------- | ------------------------------------------------------- | ----------------------------------------- |
| Activation  | First admitted/submitted scan and onboarding completion | Signup alone is not successful assessment |
| Execution   | Completion, failure, partial and orphan rates           | Completion is not finding accuracy        |
| Remediation | Proposal, merge and retest rates                        | Merge is not validated resolution         |
| Evidence    | Receipt completeness and independent verification rate  | Observed share is not universal coverage  |
| Handoff     | Report creation and qualified recipient actions         | A view is not customer acceptance         |
| Commercial  | Trial conversion and settled provider outcomes          | Checkout return is not payment proof      |
| Reliability | Admission availability, recovery and queue delay        | One readiness probe is not an SLO         |

Counts need declared windows, denominators and source systems. Coarse analytics cannot be assumed to join a person across anonymous origins or establish paid settlement.

## 12. Frequently asked questions

### Does a clean scan mean the application is secure?

No. It means the supported checks returned no relevant findings within their retained scope. Missing, incomplete and evidence-required controls remain outside that conclusion.

### Can a high grade coexist with NOT_READY?

Yes. For example, one detected High contributes only 2.5 score points before rounding, but an unresolved High can still block the gate. The grade is a prioritization summary, not the gate decision.

### What is the difference between validated and verified?

Validated describes a server-owned deterministic retest of the originating condition. Verified requires independent trusted evidence. An engine failing to repeat a finding is not either one automatically.

### Does LyraShield merge fixes automatically?

No. It can open a scope-validated server-generated PR under the applicable approval/credential boundary. Repository owners still control merge. A recognized merge can initiate a fresh, admission-bound retest.

### Will every merged fix produce a successful retest?

No. Permission, grants, entitlement, minutes, worker readiness and target state still apply. Queue/retest failures must remain visible and must not turn the original finding into proven fixed.

### Does Local/Desktop keep all data off the network?

No. Execution and findings storage are local by default, but supported AI inference uses the customer's selected provider. Licensing, updates and optional sync also have network requirements. Review the provider's data terms before sending source context.

### Can I run it indefinitely without reconnecting?

The licensing design allows seven days of offline grace after successful server verification. Revocation and verification requirements remain enforced. AI-provider connectivity is a separate requirement.

### Is Local/Desktop publicly available because it is documented here?

Documentation establishes the design/source contract, not a signed installer or enabled purchase path. Check the current release and availability record.

### What does a report signature prove?

It supports verification of a checksum against LyraShield's signing key. The reader must relate that checksum to the presented payload. It does not establish software security, current applicability or compliance.

### Does MATCH mean the release is ready?

No. MATCH confirms a comparable caller-supplied identity. The report may describe a not-ready or stale assessment. Identity, integrity and readiness must be evaluated separately.

### Are all 48 preferred agent surfaces verified?

No. Registry resolution, documented setup, package conformance and authenticated client-runtime receipts are different evidence levels. Use the current client guide and support metadata.

### Can existing scanners work alongside LyraShield?

Yes. Local checks and supported SARIF imports can complement the workflow. Imported detections remain imported evidence, not proof of executed LyraShield coverage or independent verification.

### Is this an OWASP certification or compliance report?

No. Version-pinned mappings organize evidence against selected categories. They are not endorsement, complete-standard verification, certification or legal advice.

### What happens when the worker is unavailable?

Scan admission fails closed. An unavailable assessment cannot be replaced by a favorable score or a previous expired verdict. Follow the product's surfaced status rather than repeatedly submitting ambiguous new requests.

### How should I retry after losing a response?

Reuse the same idempotency key with identical input where supported and inspect the existing operation or scan reference first. A new key can request new billable work; uncertainty is not permission to replay.

## Appendix A — Methodology versioning

Document versions and executable methodology versions are separate. Expanding this paper does not change a scanner or gate standard.

| Contract                    | Version                                     |
| --------------------------- | ------------------------------------------- |
| Vibe Security 50            | `vibe-security-50/1.2.0`                    |
| Launch Gate                 | `lyrashield-gate/2.3.0`                     |
| LyraShield Score            | `lyrashield-score/1.0.0`                    |
| AI-Built Failure Taxonomy   | `ai-built-failure-taxonomy/1.0.0`           |
| WebMCP detector / inventory | `webmcp-assurance/2` / `webmcp-inventory/1` |
| URL scan capabilities       | `url-scan/3.0.0`                            |
| Repository scan depths      | `scan-depths/1.3.0`                         |
| AI assurance mapping        | `ai-assurance-mapping/1.0.0`                |
| Scan workflows              | `scan-workflows/1.0.0`                      |
| Scan quality                | `lyrashield-scan-quality/1.0.0`             |
| Launch report payload       | `lyrashield-launch-report/2.0.0`            |
| Private report provenance   | `lyrashield-report-provenance/1.0.0`        |
| Affiliate terms             | `2026-08-18-v1`                             |

Named versions make interpretation traceable. They do not make a removed historical evaluation runner reproducible or prove that a given version is deployed.

## Appendix B — Glossary

- **Agent-minute:** metered engine-backed elapsed time under the terminal-billing policy; not a count of findings or a provider-dollar amount.
- **Applicability:** whether an immutable assessment can still describe the requested release and current policy/evidence.
- **Assessment:** a retained scope, identity and evidence record evaluated by the gate.
- **BYOK:** supported customer-supplied provider credentials for Local/Desktop.
- **Coverage receipt:** a recorded scanner/control observation and its limits.
- **Disposition:** an audited human risk/false-positive decision, not technical verification.
- **Evidence state:** the verification status of a result, separate from execution and lifecycle.
- **Launch Gate:** the versioned evidence-based target decision.
- **Loop closure:** merge handling that initiates a new retest under current admission.
- **Manifest:** a checksum-bound result record with execution provenance.
- **Perpetual fallback:** continued eligible-build use after update eligibility ends, subject to license validity and verification.
- **Scorecard:** a limited public score-derived artifact, not a private finding report or the Launch Gate.
- **Sponsor account:** the persisted account whose entitlement and balance govern a scan.

## Appendix C — Source and reading guide

For usage, consult the [user guide](./user-guide.md). For engineering contracts, consult the [yellowpaper](./yellowpaper.md). The [documentation map](./README.md) separates current owners from historical records.

Primary implementation references for this explanation:

- [AI-Built Failure Taxonomy](../packages/security/src/ai-built-failure-taxonomy.ts) and [AI App Security controls](../packages/security/src/ai-security/controls.ts).
- [Score arithmetic](../packages/score/src/index.ts) and [score persistence/sharing](../packages/db/src/score-service.ts).
- [Gate decision](../packages/gate/src/index.ts) and [assessment applicability](../packages/gate/src/applicability.ts).
- [Scan profiles](../packages/types/src/scan-profile.ts) and [URL capability bounds](../packages/types/src/url-scan-capabilities.ts).
- [Report disclosure payload](../packages/db/src/launch-report-payload.ts) and [private provenance](../packages/db/src/launch-report-provenance.ts).
- [MCP catalog](../packages/mcp/README.md), [agent registry](../packages/agent-registry/README.md) and [quality projection](../packages/types/src/scan-quality.ts).

These links identify source owners, not fresh runtime acceptance. Live evidence, commercial approvals and unresolved release gates remain in [PRD.md](../PRD.md).

---

_This whitepaper explains product behavior and commercial structure as of its revision. It is not a certification, an audit report, a security guarantee or investment advice. Private provider economics, secrets and operational receipts are excluded._
