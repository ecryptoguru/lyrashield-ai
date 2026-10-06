# LyraShield AI — Yellowpaper

## Version 1.1.0 — 2026-10-06

> The technical reference for LyraShield AI: execution profiles, evidence contracts, gate/score semantics, authorization, reports and distribution. This revision includes source-defined model classes and provider budget ceilings; credentials, deployment-specific model identifiers, actual provider spend and private operational receipts remain excluded. The [whitepaper](./whitepaper.md) explains product rationale; the [litepaper](./litepaper.md) is the short overview. Source contracts are not proof of exact-image production acceptance.

## Contents

- [1. System architecture](#1-system-architecture)
- [2. Engine boundary and model routing](#2-engine-boundary-and-model-routing)
- [3. Deterministic coverage contracts](#3-deterministic-coverage-contracts)
- [4. Evidence and integrity](#4-evidence-and-integrity)
- [5. Tenancy, authorization and billing ownership](#5-tenancy-authorization-and-billing-ownership)
- [6. Public-surface trust boundaries](#6-public-surface-trust-boundaries)
- [7. Local/Desktop architecture](#7-localdesktop-architecture)
- [8. Distribution contracts](#8-distribution-contracts)
- [9. Contract-version registry](#9-contract-version-registry)
- [10. Technical claims boundary](#10-technical-claims-boundary)
- [Appendix A — Illustrative contract interactions](#appendix-a--illustrative-contract-interactions)
- [Appendix B — Glossary](#appendix-b--glossary)
- [Appendix C — Source owners](#appendix-c--source-owners)

## 1. System architecture

The hosted application owns admission and persisted authority. The worker executes admitted jobs; a bounded engine subprocess and deterministic scanners produce observations. The database/evidence layer retains the result; pure gate and score functions interpret bounded inputs.

```text
Next.js web/API
  ├─ Identity, workspace permissions, OAuth connection grants
  ├─ PostgreSQL/RLS: targets, scans, findings, receipts, operations
  ├─ Billing, licenses, reports, scorecards, integrations
  └─ Shared scan queue
       └─ Dedicated worker
            ├─ Rebind queued authority to stored Scan
            ├─ Deterministic scanner families
            ├─ Controlled engine: REPO and engine-backed URL/API tiers
            ├─ Container sandbox and bounded runtime
            ├─ Private encrypted evidence storage
            └─ Authenticated egress / scan-scoped target relay

Astro/Cloudflare marketing
  ├─ Documentation, browser-local utilities, Security Lab
  └─ Lite Check frontend → isolated passive scanner origin

Tauri Local/Desktop
  ├─ Native license verification and OS-keychain BYOK
  ├─ Local engine/sandbox → customer-selected AI provider
  ├─ Local findings store
  └─ Explicit authenticated Cloud Sync
```

These are separate trust and deployment boundaries. A marketing deployment does not promote a worker; a successful package build does not establish client-runtime authentication.

### 1.1 Web request pipeline

The protected request boundary resolves rate limiting and request context, authenticates a supported credential, validates input, checks workspace membership/permission, and performs scoped data access. Sensitive changes also require the applicable audit and idempotency boundary.

The conceptual sequence is:

```text
Request → proxy/context → input and credential validation
        → membership + permission + delegated scope where applicable
        → workspace/account RLS transaction
        → mutation, operation/audit receipt where required
        → typed success/error response
```

Exact handler ordering differs; this diagram describes obligations, not a promise that every route uses one identical middleware function. Explicitly public health, metadata, Lite Check and report-verification endpoints use their own bounded contracts.

Protected API responses use typed success/error envelopes. List consumers must follow cursor pagination; one page is not the full workspace. Clients must not infer authorization from hidden UI controls or MCP annotations.

### 1.2 Repository scan pipeline

```text
Scan request
  → entitlement, permission, limits, target authorization
  → live worker readiness and admission-stop check
  → serialized Scan creation / shared enqueue
  → worker reloads authoritative Scan, target and policy
  → source acquisition and exact revision capture
  → isolated engine + bounded deterministic scanners
  → normalize/deduplicate candidates and findings
  → upload encrypted checksum-bound evidence
  → persist receipts, result manifest and usage disposition
  → retest finalization, score/result finalization, notifications
  → best-effort target gate refresh
```

Authority-bearing queue fields—workspace, target, goal, mode and policy—are rebound to stored state. Schema-valid queue data does not become permission to raise a budget or change the target.

Source acquisition and sandbox failures before model-backed work do not become billable completed scans. Provider usage, completion and customer minute disposition remain separate records.

### 1.3 Scan lifecycle

The normal conceptual execution path is:

```text
QUEUED → PREFLIGHT → RUNNING → VERIFYING → COMPLETED
                     │
                     └─ bounded interruption/failure/cancellation outcome
```

The diagram is not an exhaustive transition matrix. Actual transitions are guarded by the scan service and persisted recovery logic.

| Outcome/state       | Interpretation                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `COMPLETED`         | Execution/finalization finished; not a security verdict                                  |
| `PARTIAL`           | Truncated engine work retained findings and explicit coverage gaps                       |
| `FAILED`            | Work did not produce a successful completed outcome                                      |
| `CANCELLED`         | Cancellation reached a terminal result; requesting cancellation alone is not proof of it |
| `TIMED_OUT`         | Applicable deadline stopped the work                                                     |
| `STOPPED_BUDGET`    | Protected resource/spend limit stopped the work                                          |
| `REQUIRES_APPROVAL` | Approval-related workflow state; not a successful scan or evidence of execution          |

A content-filter, model-error or runtime truncation can preserve findings as PARTIAL rather than claiming complete coverage. The accompanying receipt describes the cut-short scope. Engine CLI exit codes alone must be interpreted with the retained run record and terminal reason.

### 1.4 URL/API scan pipeline

URL/API Safe is deterministic-only. Standard and Deep are engine-backed, with deterministic collection/probing retained alongside the engine.

```text
Validated URL/API target
  ├─ SAFE: SSRF-safe exact public surface/endpoint checks
  └─ STANDARD/DEEP:
       current domain proof + entitlement + scan-scoped relay grant
       → bounded target traffic through inspected relay
       → engine review + deterministic phase bounds
       → common hosted evidence/finalization boundary
```

Engine-backed API tiers also require a validated public HTTPS OpenAPI input. Authorization is bound to the target and scan; redirects, methods, paths and request budgets cannot be widened by an engine instruction.

Opaque CONNECT tunnels are rejected at the remote relay. The sandbox-local TLS adapter uses its installed CA to translate HTTPS client traffic into inspectable requests; it is not permission to disable upstream certificate validation.

Retained composed local transport tests are different from exact worker-image deployment and paid URL-engine acceptance. The dated release record must establish the latter separately.

### 1.5 Readiness and release boundaries

Admission readiness combines a live worker lease with the absence of an admission stop. Redis uncertainty fails closed. Process health alone is insufficient.

Controlled worker promotion pauses new admission, requires an empty/nonactive queue boundary, checks an immutable digest and provenance labels, restarts, verifies readiness, and releases only its own stop. Ambiguous paid work is not automatically replayed.

Database migrations are forward-only. Image rollback does not reverse schema or reconstruct an earlier ledger.

Each result's execution provenance includes product revision, worker image digest and engine revision. A source pin or green build does not establish that those identities are running.

Encrypted backup/isolated restore evidence is revision- and time-bound. It does not by itself establish a fresh backup, production restore, RPO or RTO.

### 1.6 Recovery and observable boundaries

Queue reconciliation uses stored scan state and the shared queue. Startup reconciliation, periodic active-work inspection and an idle backstop reduce orphan persistence without inventing new work.

A lost submission response is handled through durable operation status and an unchanged idempotency key, not unconditional re-enqueueing. Finalization recovery uses stored artifacts and does not repeat provider-backed analysis merely to regenerate presentation.

Optional browser error collection waits for resolved consent and emits bounded error class, static route template, release/environment and sanitized stack locations. Raw messages, target identifiers, request data, breadcrumbs, replay and browser tracing are excluded. Essential server logs and audit records are separate.

## 2. Engine boundary and model routing

The engine is a controlled subprocess. The application does not import its internal Python modules; bounded artifacts define the result boundary.

Parsed output is constrained by byte, field and count limits. Operational logs must not receive raw engine output; the source can retain a bounded redacted failure tail in private encrypted evidence. That diagnostic artifact is not a public report or trusted verification.

### 2.1 Nine profile contracts

Source authority: [`resolveScanProfile`](../packages/types/src/scan-profile.ts). Mode selects execution depth, not the business goal or permission.

| Profile ID         | Canonical mode | Engine mode | Model class | Provider cap USD | Total ceiling min | Engine ceiling min | Scanner reserve min |
| ------------------ | -------------- | ----------- | ----------- | ---------------: | ----------------: | -----------------: | ------------------: |
| `REPO_QUICK`       | QUICK          | quick       | LUNA        |             1.20 |                23 |                 20 |                   3 |
| `REPO_STANDARD`    | STANDARD       | standard    | LUNA        |             3.20 |                23 |                 20 |                   3 |
| `REPO_DEEP`        | DEEP           | deep        | SOL         |             5.00 |                45 |                 40 |                   5 |
| `WEB_APP_SAFE`     | SAFE           | none        | NONE        |                0 |                 1 |                  0 |                   0 |
| `WEB_APP_STANDARD` | STANDARD       | standard    | LUNA        |             3.20 |                23 |                 20 |                   3 |
| `WEB_APP_DEEP`     | DEEP           | deep        | SOL         |             5.00 |                45 |                 40 |                   5 |
| `API_SAFE`         | SAFE           | none        | NONE        |                0 |                 1 |                  0 |                   0 |
| `API_STANDARD`     | STANDARD       | standard    | LUNA        |             3.20 |                23 |                 20 |                   3 |
| `API_DEEP`         | DEEP           | deep        | SOL         |             5.00 |                45 |                 40 |                   5 |

The Safe API value is the resolver's rounded minute representation of a 30-second deterministic bound; it does not grant an extra 30 seconds. Other URL deterministic-phase ceilings are listed separately below.

The scanner reserve is a separate scheduling/scanner allocation, not additional engine time. Duration ceilings are not completion promises, service-level guarantees or measured typical runtimes.

LUNA profiles use the configured Luna route. SOL profiles use a Sol coordinator with Luna specialists under the worker's protected routing policy. These class labels are not deployment resource names or embedded credentials.

Provider caps are source-defined ceilings—not customer prices, expected charges, per-scan forecasts or actual reconciled spend. A positive workspace policy can lower but cannot raise the cap. The terminal result can be incomplete when a cap is reached.

### 2.2 Alias and prerequisite rules

| Target      | Accepted alias | Canonical selection |
| ----------- | -------------- | ------------------- |
| REPO        | SAFE           | QUICK               |
| REPO        | CUSTOM         | DEEP                |
| WEB_APP/API | QUICK          | SAFE                |
| WEB_APP/API | CUSTOM         | DEEP                |

Aliases do not create extra capabilities. Invalid modes/target types fail rather than silently upgrading or downgrading execution.

Repository labels are Release Check, Code Review and Deep Security Review. Current engine-backed web labels are Engine Review/Deep Live Review; API capability labels are Engine Contract Review/Deep Contract Review, with the shared resolver also exposing generic engine labels. Consumers must use the owning label contract rather than reconstructing labels from older guide prose.

Engine-backed URL/API admission requires current domain verification, valid sponsor entitlement and relay scope. API Standard/Deep additionally requires an OpenAPI document. Safe does not become an authenticated or intrusive assessment through a renamed goal.

### 2.3 Deterministic URL-phase bounds

These limits belong to the URL scanner phase, not the full engine-backed scan. MiB means 1,048,576 bytes.

| Profile          | Documents | Assets | Depth | Total MiB | Response MiB | Concurrency | Phase seconds |
| ---------------- | --------: | -----: | ----: | --------: | -----------: | ----------: | ------------: |
| WEB_APP_SAFE     |         1 |      6 |     0 |         8 |            3 |           3 |            60 |
| WEB_APP_STANDARD |        20 |     30 |     2 |        25 |            3 |           4 |           120 |
| WEB_APP_DEEP     |        40 |     50 |     3 |        50 |            5 |           4 |           180 |
| API_SAFE         |         1 |      0 |     0 |         5 |            5 |           1 |            30 |
| API_STANDARD     |         0 |      0 |     0 |        20 |            2 |           2 |            90 |
| API_DEEP         |         0 |      0 |     0 |        40 |            2 |           2 |           150 |

Zero document/asset counts on contract profiles describe contract-operation selection rather than a page crawler. Limits must be interpreted together with allowed operations/methods.

| Profile          | Operations | Method probes | Origin probes | Allowed deterministic methods | API spec |
| ---------------- | ---------: | ------------: | ------------: | ----------------------------- | -------- |
| WEB_APP_SAFE     |          0 |             0 |             0 | GET                           | No       |
| WEB_APP_STANDARD |          0 |             0 |             0 | GET                           | No       |
| WEB_APP_DEEP     |          0 |            20 |            10 | GET, HEAD, OPTIONS            | No       |
| API_SAFE         |          1 |             0 |             0 | GET                           | No       |
| API_STANDARD     |         10 |             0 |             0 | GET, HEAD                     | Yes      |
| API_DEEP         |         25 |             0 |            10 | GET, HEAD, OPTIONS            | Yes      |

These are collector/probe registry values. They do not define every engine interaction or override the scan-scoped relay's own target authorization and budgets. Safe public checking, deterministic behavior probes and authorized engine review remain separately bounded.

### 2.4 Provider accounting and customer minutes

Private receipts retain model route, request count, standard/long-context buckets, cache reads/writes and reconciled cost. Customer-facing usage is agent-minutes, not those private provider totals.

Worker metering requires a receipt bound to the scan and evidence of completed or affirmative model-backed work. Deterministic-only and pre-provider failures do not consume minutes. Failed terminal outcomes follow the non-billing rule; cancellation charges only observed elapsed work without a minute floor. Other partial/limit dispositions must follow finalization rather than be inferred from engine exit code alone.

Deep/Custom apply the Cloud 3× multiplier. Provider-dollar caps and the account's minute balance are separate controls.

Missing or unpriceable accounting is not repaired with invented token/cost values. Unsupported model receipts remain unreconciled; that state is private accounting evidence, not an accuracy signal.

### 2.5 Caching, deadlines and cancellation

Prompt caching reports cache-read/cache-write usage where supported. A cache hit is a provider accounting observation, not retained verification of the application.

Exact triage-result reuse is another optimization. Current source keeps it off by default and requires separate quality, tenant-isolation and operational gates. Its configuration presence does not prove live use or lower production cost.

Cancellation and hard runtime limits bound the engine process. A user's CLI interrupt can stop waiting while hosted work continues; it is distinct from a server-confirmed scan cancellation.

Engine CLI `0`/`2` denote completed results without/with findings under that engine contract. Other codes and terminal receipts describe failure/truncation; callers must retain the bounded result rather than equating “process exited” with “assessment completed.”

## 3. Deterministic coverage contracts

This section describes deterministic evidence and catalog mapping. It does not imply that engine-led controls are deterministic or that every catalog family ran in every profile.

### 3.1 Vibe Security 50 (`vibe-security-50/1.2.0`)

| Strategy          | Count | Control ranks                                   |
| ----------------- | ----: | ----------------------------------------------- |
| Deterministic     |     5 | 3, 27, 29, 37, 45                               |
| Hybrid            |    11 | 1, 2, 10, 14, 20, 28, 31, 32, 38, 39, 47        |
| Engine-led        |    27 | 4–9, 11–13, 15–19, 21–26, 30, 33, 40–42, 44, 49 |
| Evidence-required |     7 | 34, 35, 36, 43, 46, 48, 50                      |

The full hosted coverage-contract path records per-control outcomes. `DETECTED`, `NO_FINDING`, `INCONCLUSIVE`, `NOT_APPLICABLE` and `EVIDENCE_REQUIRED` are interpretation labels; they are not the finding-lifecycle enum or an application pass/fail certificate.

A completed scanner family is execution evidence. It does not mean all controls in that family's category returned a positive security conclusion. Missing, unreadable or capped source inputs must retain incomplete scope.

CVE enrichment through CISA KEV/FIRST EPSS adds prioritization context where available. It does not independently change verification state or establish application reachability.

### 3.2 WebMCP Assurance (`webmcp-assurance/2`, inventory `webmcp-inventory/1`)

| Control   | Review subject                                   | Catalog severity |
| --------- | ------------------------------------------------ | ---------------- |
| WEBMCP-01 | Annotation/behavior mismatch                     | HIGH             |
| WEBMCP-02 | External content without untrusted-content hint  | MEDIUM           |
| WEBMCP-03 | Unsafe/dynamic cross-origin exposure             | HIGH             |
| WEBMCP-04 | Unsafe permissions or disabled origin isolation  | HIGH             |
| WEBMCP-05 | Durable mutation without visible confirmation    | CRITICAL         |
| WEBMCP-06 | Sensitive/unbounded input-output contract        | MEDIUM           |
| WEBMCP-07 | Network operation lacks cancellation propagation | MEDIUM           |
| WEBMCP-08 | Registration lacks lifecycle cleanup             | MEDIUM           |
| WEBMCP-09 | Weak schema or missing runtime validation        | HIGH             |
| WEBMCP-10 | Duplicate/overlapping/misleading tool contract   | MEDIUM           |
| WEBMCP-11 | Embedded credential or secret                    | HIGH             |
| WEBMCP-12 | Prompt-injection surface in tool contract        | HIGH             |
| WEBMCP-13 | Spec drift/misplaced registration option         | MEDIUM           |
| WEBMCP-14 | Browser-guidance contract budget exceeded        | MEDIUM           |

The shared analyzer handles discovery, deterministic inventory serialization/hash and policy review. The browser-safe entrypoint, bounded worker source analysis, CLI snapshots and guarded Action subset have different supplied scope.

An empty user-supplied `apiKey` field is not an embedded secret. Imperative documentation is not automatically malicious instruction. Findings retain contextual false-positive limits.

The runtime checker emits `lyrashield-webmcp-runtime/1` observations on opt-in authorized fixtures. Runtime PASS/INCONCLUSIVE semantics do not relabel static detections. A fixture browser observation is not universal client acceptance.

Dashboard tools are page/workspace-scoped and read/prepare-only where defined. Preparing the New Scan form does not enqueue work; hosted delegated MCP is a separate execution path.

### 3.3 AI App Security (AI-01…08)

| Control | Subject                                  | Strategy      | Mapping    | Catalog severity |
| ------- | ---------------------------------------- | ------------- | ---------- | ---------------- |
| AI-01   | Missing prompt-input validation          | Deterministic | LLM01:2025 | HIGH             |
| AI-02   | Sensitive data in model context          | Deterministic | LLM02:2025 | CRITICAL         |
| AI-03   | Resolved AI dependency/advisory evidence | Advisory      | LLM03:2025 | MEDIUM           |
| AI-04   | Model output in dangerous sinks          | Deterministic | LLM05:2025 | CRITICAL         |
| AI-05   | Unbounded agent permissions              | Deterministic | LLM06:2025 | HIGH             |
| AI-06   | System prompt exposed client-side        | Deterministic | LLM07:2025 | HIGH             |
| AI-07   | Unauthenticated vector/RAG access        | Deterministic | LLM08:2025 | HIGH             |
| AI-08   | Missing consumption bounds               | Deterministic | LLM10:2025 | MEDIUM           |

Browser-local analysis excludes hosted AI-03 advisory enrichment. Selected-file scope cannot establish a full-repository score or runtime provider behavior.

Hosted source discovery prioritizes supported production/config files, excludes generated material and retains eligible/scanned/skipped/byte counts and bounded reason samples. Mode file caps are Quick/Safe 200, Standard 500 and Deep/Custom 1,000, alongside time/byte/walk limits.

Advisory absence requires supported exact resolution and fresh evidence. A version range alone is not proof of vulnerability when a lockfile resolves a safe version. Stale/missing advisory input cannot support a clean private score claim.

AI App Security's private score is separate from `lyrashield-score/1.0.0`. Optional triage implementations and result-cache configuration are not proof that hosted triage/calibration has released.

### 3.4 AI assurance framework mapping (`ai-assurance-mapping/1.0.0`)

The mapping relates observed signals to selected OWASP LLM categories. States include `OBSERVED`, `EVIDENCE_ACCEPTED`, `NOT_ASSESSED` and `NOT_APPLICABLE`; they are not certifications.

NIST AI RMF, MITRE ATLAS and EU AI Act mappings remain disabled pending recorded source/version/scope review. Separately, the standards registry pins OWASP Top 10 2021, API Top 10 2023, LLM Top 10 2025, CWE Top 25 2024 and selected ASVS 5.0.0 L1 requirements.

A mapped category is not a claim of complete standard coverage. Repository IaC/SAST mapping does not establish released standalone cloud/container/IaC targets.

### 3.5 Authorized AI safety test pack

The private-beta schema permits only the fixed catalog, customer-authorized non-production HTTPS host and declared credential mode. It excludes arbitrary model-selected tests and destructive execution.

| Plan bound                          |                                Maximum |
| ----------------------------------- | -------------------------------------: |
| Cases                               |                                      5 |
| Requests                            |                                     25 |
| Duration seconds                    |                                    900 |
| Response bytes                      |                              1,048,576 |
| Per-case requests allowed by schema | 5, further fixed by each catalog entry |

Case types are prompt injection, tool-result injection, system-prompt disclosure, secret disclosure and unexpected tool calls. Fixture, expected predicate, request bound and stop condition must match the fixed catalog; input cannot turn the schema maximum into permission to add new cases.

The approved host must match the endpoint. Test-credential mode requires a credential reference; no-auth mode rejects one. Raw samples follow the declared disabled/encrypted-private storage policy and are excluded from public reports, logs, analytics and model context.

This contract is distinct from the historical first-party prompt-injection evaluation and from arbitrary endpoint fuzzing. No adversarial-robustness claim follows.

### 3.6 Taxonomy traceability

The eight AIB classes map to scanner surfaces and control IDs in the [versioned taxonomy](../packages/security/src/ai-built-failure-taxonomy.ts). Mapping expresses intended review responsibility, not detection performance.

The [whitepaper taxonomy section](./whitepaper.md#54-ai-built-failure-taxonomy) explains the mechanisms. Technical consumers must distinguish a catalog surface such as `iac` from a separately admitted target type; the latter remains deferred.

## 4. Evidence and integrity

The evidence model separates observations, persisted artifacts, finding interpretation and policy decisions. The separation prevents a model statement or lifecycle edit from masquerading as verified evidence.

### 4.1 Entity relationships

```text
Workspace → Target → Scan
                     ├─ FindingCandidate → Finding
                     ├─ ScanCoverageReceipt
                     ├─ Evidence artifact references
                     └─ ScanResultManifest
Finding → FixProposal → PullRequest
Finding → Retest → NEW Scan
Target + retained assessment → append-only GateVerdict
GateVerdict → Report: public payload + PRIVATE issue-time provenance
```

This is a conceptual ownership map, not a replacement for every schema foreign key. Workspaces own data scope; accounts own billing balances and sponsorship (§5.3).

| Record           | Role                                                           |
| ---------------- | -------------------------------------------------------------- |
| Scan             | Authorized execution identity, profile, lifecycle and sponsor  |
| Candidate        | Scanner observation/provenance before trusted interpretation   |
| Finding          | Normalized issue, lifecycle, severity and verification context |
| Coverage receipt | Scanner/control outcome with limits                            |
| Evidence         | Encrypted private artifact and integrity metadata              |
| Manifest         | Result, execution provenance and exact integrity input         |
| Retest           | Finding-bound relationship to a newly owned scan               |
| Fix proposal/PR  | Remediation plan, server-owned patch and execution record      |
| Gate verdict     | Immutable assessment decision and binding                      |
| Report           | Frozen disclosure payload and private issue-time binding       |

### 4.2 Manifest integrity

Current source exports result-manifest version 7. Historical v5/v6 records are not rewritten into version 7 merely because a reader understands them.

For new-format persisted rows, `checksumInput` is the exact JSON text whose UTF-8 bytes were hashed. Verification computes SHA-256 over that text and checks structural equality between parsed text and stored JSONB.

| Verifier outcome | Exact implication                                                          |
| ---------------- | -------------------------------------------------------------------------- |
| MATCH            | Stored hash agrees with exact text and parsed JSON agrees with JSONB       |
| MISMATCH         | Invalid checksum, changed bytes, malformed JSON or structural disagreement |
| UNAVAILABLE      | Row or exact checksum input is missing, including legacy null-input rows   |

Re-serializing JSONB is not a substitute for checking exact original bytes. Missing legacy input stays unavailable; backfilling a new serialization would manufacture a different historical claim.

Duplicate persistence and pending finalization must compare stored integrity inputs rather than silently overwrite an earlier manifest. Product/worker/engine execution identity is part of the manifest boundary; readiness fails closed without required provenance.

A matching hash establishes artifact consistency, not the truth of every scanner observation or independent verification of a finding.

### 4.3 Evidence storage and audit

Evidence uses the shared upload path with checksum and valid encryption-key metadata. The self-describing envelope format uses AES-256-GCM and private storage; raw storage URIs are not finding-detail/public disclosure fields.

Fail-closed encryption/storage behavior must remain distinct from a source implementation claim: runtime round-trip, isolation and tamper tests need their own retained evidence.

Sensitive audit creation uses the extended data client's advisory-locked transaction to order `prevHash`/`hash`. Do not infer that arbitrary application writes are automatically included merely because an audit table exists.

### 4.4 Finding lifecycle versus verification

The lifecycle vocabulary includes OPEN, FIX_READY, PR_OPENED, TICKET_CREATED, FIXED_PENDING_RETEST, FIXED, ACCEPTED_RISK, FALSE_POSITIVE and DUPLICATE.

A conceptual remediation branch is:

```text
OPEN → proposal/patch ready → PR_OPENED → merged change
     → FIXED_PENDING_RETEST → trusted retest result
```

This is not a required transition sequence. A manual fix, direct retest or recorded disposition takes a different supported path. Proposal readiness and lifecycle changes do not establish resolution by themselves.

Verification tiers are separately interpreted as DETECTED, VALIDATED, VERIFIED, BLOCKED or INCONCLUSIVE. NOT_ASSESSED/NOT_APPLICABLE belong to control context rather than becoming successful finding-verification tiers.

```text
Scanner candidate → DETECTED
  ├─ trusted independent evidence → VERIFIED
  ├─ complete identity-bound deterministic clean retest → VALIDATED
  └─ incomplete/engine-only absence/unsupported evidence → INCONCLUSIVE
```

Independent verification is not a compulsory intermediate step before retest validation. Confidence never sets `verified`.

Human dispositions require recorded rationale and applicable policy/evidence binding. A direct historical FIXED or unbound ACCEPTED_RISK/FALSE_POSITIVE value is not sufficient resolution for the gate.

### 4.5 Deterministic retest validation

Source retest finalization consumes stored original and new-scan artifacts. Both checksums must be MATCH before identity is trusted.

A clean absence can validate only when:

1. the candidate sources are known deterministic retest families, not engine/unknown mixtures;
2. baseline and retest manifests match their stored scan/target identity;
3. exact source revisions exist for repository targets, or matching URL checksums exist for URL/API targets;
4. the originating deterministic scanner families completed in both scans;
5. supported stored terminal receipts establish COMPLETED for both;
6. the originating condition is absent in the fresh retest evidence.

Repository revisions may differ after a fix; equality is not required. Matching URL checksums bind the same target observation identity rather than asserting every response byte never changed.

If requirements are missing or legacy-unavailable, the source emits an inconclusive receipt with missing-evidence reasons. Engine-only absence never establishes deterministic validation.

**Deployment caveat:** the dated production audit records a deployed checksum-match gap. Current source checks do not prove its promotion or retrospectively validate historical receipts. This paper performs no production-row audit; [PRD release status](../PRD.md#9-release-status) owns that gate.

### 4.6 Fix-PR pipeline and scope policy

```text
Finding with scanned baseCommit and structured fix
  → FixProposal + fix-generation job
  → deterministic diff generation / mechanical scope validation
  → private encrypted patch artifact and checksum
  → server resolves exact proposal/base/diff context
  → browser human approval OR authorized credential execution
  → revalidation + PR creation (never merge)
  → recognized GitHub merge webhook
  → durable NEW retest Scan + Retest association
  → admission-aware enqueue / result finalization / gate refresh
```

The privileged PR route accepts proposal identity/workspace scope, not a caller-authored diff, branch, title or body. Base revision and patch checksum are server-resolved inputs to operation identity.

| Policy branch                                     | Paths                       | Lines added + removed |
| ------------------------------------------------- | --------------------------- | --------------------: |
| Starter, Trial, Free, unknown/unrecognized values | Current finding file only   |                   100 |
| Pro and recognized higher/legacy paid plan values | Finding-implicated file set |                   200 |

A legacy TEAM/BUSINESS/LAUNCH_ASSURANCE policy value is compatibility, not a current sold plan. Unknown strings fail to the strictest scope.

Browser requests bind exact execution to a human approval. API-key/delegated OAuth requests additionally require `fix:approve` and run under their verified credential/grant authorization; they do not universally create a new per-request browser approval. Every path must still pass patch, target and operation validation.

Merge handling serializes redeliveries, records merge state and associates the retest with a new scan. If admission or enqueue fails, the durable association supports controlled recovery; it does not mark the finding fixed or replay new provider work unconditionally.

### 4.7 Launch Gate evaluation

Source functions are pure; persistence and authority resolution live in the database service. The same bounded input yields the same verdict without I/O or hidden clock reads.

Required families in the current matrix are:

| Target/profile                           | Required scanner families                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| REPO                                     | engine, sca, secrets, agent_config, ml_supply_chain, ai_app_security, sast, iac |
| WEB_APP/API Safe                         | url, ai_app_security                                                            |
| WEB_APP/API Standard/Deep/Custom         | engine, url, ai_app_security                                                    |
| CLOUD_ACCOUNT, CONTAINER, standalone IAC | Not covered; cannot receive READY/NOT_READY as an assessed target               |

An applicable required family needs COMPLETED or NOT_APPLICABLE receipts. At least one completed observation must exist. `engine-scope:`/`engine-gap:` rows are model self-report metadata and cannot satisfy/fail deterministic family coverage by themselves.

Decision precedence:

| Order | Condition                                                                                               | Verdict               |
| ----- | ------------------------------------------------------------------------------------------------------- | --------------------- |
| 1     | Unsupported target type                                                                                 | INSUFFICIENT_EVIDENCE |
| 2     | No completed coverage, missing/incomplete required family, or explicitly incomplete assessment identity | INSUFFICIENT_EVIDENCE |
| 3     | Unresolved Critical/High blocker after applicable resolution/disposition                                | NOT_READY             |
| 4     | Unresolved finding lacks scoped positive evidence and applicable disposition                            | INSUFFICIENT_EVIDENCE |
| 5     | Remaining implemented checks satisfied                                                                  | READY                 |

OPEN, FIX_READY, PR_OPENED, TICKET_CREATED and FIXED_PENDING_RETEST count as unresolved. DUPLICATE depends on canonical resolution. Historical direct FIXED and unbound human dispositions remain blocking until trusted resolution/applicable disposition exists.

Medium/Low do not independently yield NOT_READY. They can still prevent READY under the positive-evidence requirement. INFO is not a severity blocker, but the source's unresolved-without-evidence rule is not restricted to Critical/High.

Non-coverage remains disclosed even when it is outside required families. READY is a scoped standard result, not absence of all possible risks.

### 4.8 Applicability: historical verdict versus current release

The assessment snapshot retains scan identity, completed time, manifest checksum/version, policy fingerprint and a commit/artifact identity. Gate assessment version is 2.

Applicability checks are separate from immutable history:

| Reason code              | Condition                                                 |
| ------------------------ | --------------------------------------------------------- |
| ASSESSMENT_UNAVAILABLE   | Missing/unsupported snapshot                              |
| UNSUPPORTED_IDENTITY     | Requested kind cannot be compared with the retained kind  |
| IDENTITY_MISMATCH        | Requested release reference differs                       |
| ASSESSMENT_EXPIRED       | Current evaluation time is at/after completion + 24 hours |
| POLICY_CHANGED           | Current policy fingerprint differs                        |
| NEWER_ASSESSMENT_ATTEMPT | A newer attempt must finish before reuse                  |
| EVIDENCE_CHANGED         | Evidence/disposition/verification inputs drifted          |

Any returned reason makes effective state INSUFFICIENT_EVIDENCE without rewriting the historical verdict.

Read-only views without an expected release reference label the assessment's own identity. A caller supplying a commit/digest enforces the comparison; the UI must not imply it checked deployment when no reference was supplied.

### 4.9 Score specification

`lyrashield-score/1.0.0` consumes severity, lifecycle status, the independent-verification boolean and active-secret flag. It is not the gate evaluator.

Eligible pure-function statuses are OPEN, FIX_READY, PR_OPENED, TICKET_CREATED, FIXED_PENDING_RETEST and ACCEPTED_RISK. Other lifecycle statuses contribute nothing to that pure calculation.

| Severity | Weight |
| -------- | -----: |
| CRITICAL |     25 |
| HIGH     |     10 |
| MEDIUM   |      4 |
| LOW      |      1 |
| INFO     |      0 |

For each eligible finding:

```text
deduction = weight(severity)
          × (independently verified ? 1 : 0.25)
          × (accepted risk ? 0.5 : 1)

score = max(0, floor(100 - sum(deductions) + 0.5))
```

| Score interval | Initial grade |
| -------------- | ------------- |
| 98–100         | A_PLUS        |
| 90–97          | A             |
| 80–89          | B             |
| 65–79          | C             |
| 50–64          | D             |
| 0–49           | F             |

Grade caps then apply: open Medium-or-higher prevents A_PLUS; open verified Critical caps at C; open verified High caps at B; open active verified secret caps at D. Caps do not alter the number.

The DB input adapter retains untrusted historical FIXED values as FIXED_PENDING_RETEST unless verification is VALIDATED/VERIFIED. Retest validation does not rename a finding independently verified.

Pure share eligibility is Standard/Deep plus default-branch input. Persistence additionally checks completed/NOT_APPLICABLE scanner-family receipts and a triaged ratio no greater than 25%. It stores a 30-day score snapshot expiry; this is not the gate's 24-hour freshness.

The current completion adapter supplies canonical/default-branch eligibility rather than establishing a provider-backed ref comparison for every workflow. Consumers must not turn the pure flag into a stronger branch-provenance claim.

Scorecard release labels derive from the numeric score: at least 80 is GO, at least 40 is GO_WITH_CONDITIONS, otherwise NO_GO. These are not the gate's evidence verdicts. Legacy shares without that label normalize to NOT_EVALUATED rather than reconstructing history from a grade.

### 4.10 Report payload, signing and identity

`buildLaunchReportPayload` is the sole public launch-report constructor. It canonically orders object keys, serializes the allowed payload and hashes it with SHA-256. Signing fields/checksum are excluded from that input as defined by the constructor.

The payload contains version, verdict label/standard, neutral or opted-in display name, assessment/evaluation/issue timestamps, applicability expiry, opaque scope commitment, coverage/non-coverage, aggregate counts/dispositions and staleness.

Public payloads exclude source paths, repo/URL, scan identity, raw evidence and private assessed identity. Medium/Low count slots are null with not-evaluated disclosure rather than false zeros.

Issue-time selection and applicability inputs are read in one RepeatableRead snapshot. The later report write carries exactly that selected verdict's binding; a concurrent new verdict cannot mix one assessment's counts with another's identity.

If selection fails, issuance fails. If a verdict was selected but applicability evaluation fails, source permits an explicitly stale/unknown report. No signing key yields unsigned issuance rather than a fabricated signature.

Private `Report.provenanceJson` binds verdict ID/checksum, assessed identity, assessment/issue/check timestamps, applicability and bounded reason codes. It is not merged into public payloads/downloads/shared renderers.

The verify endpoint accepts a report checksum and base64 ed25519 signature against the server's configured key; it never accepts a caller-supplied trust key. Missing verification configuration is an error, not a positive result. Signature verification alone does not recompute an arbitrary uploaded document's checksum—the presented payload must be checked against that checksum separately.

Optional release confirmation requires signature success, the report identity, live share token, matching stored report checksum and supported private provenance.

| Confirmation | Meaning                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| MATCH        | Comparable supplied identity equals retained private identity                                                                      |
| MISMATCH     | Comparable supplied identity differs                                                                                               |
| UNAVAILABLE  | Invalid/revoked/expired/cross-report capability, invalid binding/checksum, unsupported kind, legacy provenance or failed signature |

Comparison is case-normalized and timing-safe. The response never returns the stored release identity. Confirmation does not evaluate whether that report is still current or the release ready.

Shares expire/revoke independently of cryptographic validity. Read-time stale presentation of expired payloads does not rewrite signed bytes. A 30-day share is not a 30-day current assessment.

## 5. Tenancy, authorization and billing ownership

### 5.1 Tenancy

Workspace queries explicitly carry `workspaceId`. Request context uses AsyncLocalStorage; transaction-local RLS context avoids connection-pool leakage. Child records are scoped through their owning parents under fail-closed policies.

Soft-delete and direct workspace-scope model sets are closed lists containing only compatible schema fields. Missing context must not become a global query fallback.

Production app/worker runtime roles must be neither superuser nor BYPASSRLS. Separately scoped system paths need explicit reviewed authority; the public passive scanner does not inherit a global system credential.

### 5.2 Authorization

Role hierarchy is OWNER, ADMIN, SECURITY_ADMIN, APPSEC_MANAGER, BILLING_ADMIN, DEVELOPER, MEMBER, EXTERNAL_PENTESTER, AUDITOR and VIEWER. Current operational permissions are added to all active member roles; hierarchy remains relevant to administration and assignment.

| Caller                                        | Read boundary                                                     | Mutation boundary                                                                |
| --------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Browser cookie session                        | Active membership and resource permission                         | Same-origin safeguards; action-specific approval/elevation where required        |
| Workspace API key via REST/local stdio        | Workspace binding, read scope, active creator, current permission | Write scope and current permission; fix PR additionally requires fix:approve     |
| Hosted remote MCP API key                     | Authorized read tools                                             | connect_required; no mutation is queued/executed                                 |
| Hosted remote OAuth without usable delegation | Supported read scope                                              | connect_required; retired approvalId path is not accepted                        |
| Connected delegated OAuth                     | Membership, connection and scope                                  | Allowed workflow/target/profile/expiry/version, idempotency and budget rechecked |

Existing restricted grants are not silently widened. A new broad consent can cover current/future targets only when that is disclosed and stored; a narrower retained grant remains narrower.

Scan admission records delegated connection/authorization version. The worker rechecks that binding so revocation, expiry, inactivity, version change or narrowing can stop queued work before provider execution.

Workspace API keys are managed by Owner/Admin browser sessions, shown in full once and stored only by SHA-256 hash/prefix. Up to 20 active keys per workspace are allowed; expiry, revocation, deletion and inactive creator membership fail authentication.

Platform administration is a separate verified allowlist/TOTP browser boundary. Bearer credentials and workspace roles cannot cross it. Source includes nonce/elevation and audit controls; disabled admin mutations must not be described as available simply because the read console exists.

### 5.3 Account-owned billing

Subscriptions, usage, allowances, packs, grace and overage belong to account IDs. Workspace fields on account-ledger rows are attribution/display, not the payer selected by request input.

Sponsor resolution comes from persisted identity and the Agency sponsorship boundary, never a client-provided payer ID. Entitlement evaluates the sponsor's effective plan and account RLS context.

Annual allowances replenish monthly from the term anchor, with month-end clamping and idempotent cycle grants. No rollover/catch-up stacking should be inferred from a term payment.

Minute debit draws from the current monthly pool, oldest valid pack, then permitted overage. Deep uses 3×; pre-provider and failed outcomes follow the non-billing policy (§2.4). Ledger money uses fixed-precision Decimal, not floating-point telemetry.

### 5.4 Durable operation and retry contract

Consequential workflows use a stable request key and bounded immutable input identity. Identical retries return the existing operation; changed input with the same key conflicts.

A durable operation ID, scan ID and MCP task ID are different references. Operation inspection remains bound to the originating principal/workspace; another credential is not a recovery bypass.

After an uncertain external outcome, inspect the recorded result/reference and permitted recovery. Do not create a new key merely to bypass ambiguity or auto-replay paid scans.

## 6. Public-surface trust boundaries

### 6.1 Lite Check (scanner.lyrashieldai.com)

The marketing `/scan` page fronts a separately isolated passive scanner. It does not invoke the repository engine or engine-backed URL profiles.

It fetches the exact public page and at most six linked same-origin JS/CSS assets. It reviews headers, transport, high-confidence credential patterns, data-layer markers and framework signals without returning matched secret values.

Bounded controls include HTTP(S)-only input, no embedded credentials/query/fragment, private/loopback/metadata/reserved range denial, DNS connection pinning, at most three revalidated redirects, 10-second fetch timeout, 4 MiB page and 750 KiB per linked asset caps.

It never authenticates, exploits, enumerates databases, actively tests RLS, crawls arbitrary paths or retrieves exposed environment-file paths. Bot verification and production rate-limit/admission requirements fail closed where required.

Bodies, assets, matched secrets and finding detail are not server-persisted results. Signed aggregate cards omit target/finding information and use noindex/no-referrer presentation. Public/publishable configuration is not automatically classified as a privileged leaked secret.

### 6.2 Browser-local tools and Security Lab

Supplied source/pasted inputs remain in browser-local analysis. Parsing can use a lazy worker; safe rewrites update the local preview rather than a remote repository.

Analytics is a separate coarse event channel, with per-surface allowlists and DNT/GPC behavior. Do not describe it as permission to upload inputs, filenames, target hostnames or raw finding text. Lite Check analytics excludes target-derived identifiers, including domain hashes.

Optional error collection is independent of analysis input and essential server audit. Consent to one is not consent to all telemetry.

### 6.3 Public scorecards and reports

Public scorecard keys are grade, scope, scan date, model version, resolved-findings count, release verdict and verdict version. The score-derived verdict is not substituted for an evidence gate.

The public launch report has its own aggregate constructor (§4.10). Private technical reports can carry different content; their share capabilities must be reviewed according to the report type. Do not apply the scorecard allowlist to every report or assume every report is publicly indexable.

Revoked/expired share capability reads fail closed. Privacy-bounded view/share events are not verified external impressions, conversions or customer acceptance.

## 7. Local/Desktop architecture

Tauri v2 uses a Rust core with a React/Vite frontend. Native code owns license validation, credentials, engine launch and trusted local persistence.

```text
Native license/eligibility gate
  → container/runtime detection
  → selected BYOK route from OS keychain/auth flow
  → filtered child environment + bundled production engine
  → local sandbox and provider requests
  → local scan/finding history
  → optional session-bound Cloud Sync
```

### 7.1 License and fallback

License verification uses ed25519 over canonical JSON, with cross-language golden-vector tests. Native verification is outside the webview's JavaScript state; this does not make a compromised local host harmless.

Update eligibility is separate from signature validity. An expired update term allows an eligible build or signed fallback, while explicit revocation invalidates operation.

After a successful server verification, seven rolling days of offline grace can apply. Expiry requires reconnecting; a local signature check alone cannot indefinitely establish non-revocation.

The current signing-key-compromise [runbook](./operations.md#license-signing-key-compromise-ff4) records incomplete coordinated license-key rotation/reissue. This paper does not claim a multi-key trust store or safe end-to-end recovery exists.

### 7.2 BYOK and provider exposure

Supported subscription sign-in is delegated to the engine auth path; Azure credentials are validated and stored through the OS keychain boundary. React receives bounded credential metadata rather than raw keys.

The child environment is allowlisted and stale provider/model routing variables are stripped. The selected provider route is resolved explicitly so parent variables cannot silently shadow it.

Model-assisted local review can send context to the selected AI provider. Provider requests, licensing, updater traffic, authorized target/dependency work and explicit sync are distinct network needs. “Telemetry off” does not mean “no egress” or “offline inference.”

Production engine sidecars are selected by the release workflow; production does not fall back to arbitrary PATH executables. Debug overrides are development contracts, not signed distribution proof.

### 7.3 Sandbox and updates

Scans require a detected container runtime; unsupported/absent runtime is not an invitation to bypass isolation.

Updater artifacts are signature-checked and eligibility-gated. Users see update information and confirm download/install/restart; update expiry does not deactivate an otherwise valid eligible build.

Signed/notarized publication remains a separate gate. Source support for macOS/Windows and compiled trust checks does not establish a downloadable accepted installer.

### 7.4 Sync contract and local evidence differences

Cloud Sync is opt-in and license/workspace-entitlement bound. The native client retains the license credential in keychain and a short-lived session in Rust memory.

Finding/report batches use server-owned cursor sequencing, compare-and-swap and idempotent replay. A stale cursor requires reconciliation, not guessed advancement. Revocation and entitlement are checked at endpoints.

Uploaded local findings remain unverified. Direct FIXED input is not accepted as hosted retest proof; bounded reports/findings and cursor commit consistently.

Local persistence does not include every hosted manifest/receipt field. The exact parity disclosure in §8.5 is authoritative for that distinction.

## 8. Distribution contracts

### 8.1 Client surfaces and release identity

Current documented package pins are CLI `0.2.14`, MCP `0.2.12` and Agent Plugin `0.1.31`, with Node.js 24 or newer. Source, published tarball, immutable marketplace release and actual client discovery/authorization are separate identities.

The published CLI archive also has documented source-copy drift; current integration guidance can be newer than its immutable bundled instructions. Do not republish an existing version or imply version equality establishes byte-identical source behavior.

| Surface       | Contract                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------- |
| CLI           | Setup, preflight, recorded work, status/recovery, advisory checks and gate commands             |
| SDK           | Typed `/api/v1` resource calls and durable request handling                                     |
| MCP           | Shared API-backed tools plus a local-only advisory diff tool                                    |
| Agent Plugin  | Portable manifests/skills and client-specific shims; host controls activation                   |
| GitHub Action | Account-less diff-aware local SAFE/AGGRESSIVE gate; DEEP rejected                               |
| Public API    | Version/deprecation policy owned by policies.md; executable request shapes remain authoritative |

`gate --verdict` exits 0 READY, 1 NOT_READY and 2 insufficient evidence/error. Local `gate` has a different severity/diff contract; do not apply verdict exit semantics to every CLI command.

### 8.2 MCP tool catalog: 21 tools

Read tools do not consume write authorization merely because their names contain create/generate; tool semantics and server authorization govern the classification.

| Tool                                  | Kind           | Purpose                                                  |
| ------------------------------------- | -------------- | -------------------------------------------------------- |
| `lyrashield_list_workspaces`          | Read           | Accessible workspaces                                    |
| `lyrashield_list_targets`             | Read           | Paginated authorized targets                             |
| `lyrashield_get_scan_status`          | Read           | Scan state, timing and events                            |
| `lyrashield_get_scan_quality`         | Read           | Server-computed quality projection                       |
| `lyrashield_get_scan_eligibility`     | Read           | Advisory admission preflight                             |
| `lyrashield_get_findings`             | Read           | Paginated findings and filters                           |
| `lyrashield_explain_finding`          | Read           | Detail and explanation                                   |
| `lyrashield_generate_fix_plan`        | Read           | Assemble guidance without saving a proposal              |
| `lyrashield_get_launch_readiness`     | Read           | Target gate/applicability state                          |
| `lyrashield_create_pr_security_recap` | Read           | Assemble recap text                                      |
| `lyrashield_check_diff`               | Local advisory | Supplied diff/snapshot heuristic; no credential required |
| `lyrashield_list_scan_attachments`    | Read           | Workspace input-evidence metadata                        |
| `lyrashield_scan_target`              | Write          | Start admitted scan                                      |
| `lyrashield_cancel_scan`              | Write          | Request cancellation                                     |
| `lyrashield_run_pr_scan`              | Write          | Start PR-focused scan                                    |
| `lyrashield_record_fix_proposal`      | Write          | Save a proposal                                          |
| `lyrashield_verify_fix`               | Write          | Queue server-owned retest                                |
| `lyrashield_create_report`            | Write          | Generate report                                          |
| `lyrashield_upload_scan_attachment`   | Write          | Upload bounded text evidence                             |
| `lyrashield_delete_scan_attachment`   | Write          | Delete owned input evidence                              |
| `lyrashield_request_fix_pr`           | Write          | Request authorized server-patch PR; never merge          |

All API-backed operations still evaluate membership, credentials and service boundaries. Safety annotations are host hints, not grants.

Tool inputs are checked against advertised schemas. Results are capped at 256 KiB serialized and explicitly marked when truncated. A truncation marker cannot be treated as a complete findings set.

Attachment upload through MCP has an approximately 100 KB text bound; CLI/SDK supported uploads have a 1 MiB limit. Attachments are input evidence, not executable arbitrary host paths.

### 8.3 Transports, protocols and tasks

Local stdio and hosted Streamable HTTP share tool definitions but not identical credential/task persistence.

The installed SDK baseline is 1.30.1. Supported protocol negotiation includes 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 and 2024-10-07. Source does not advertise 2026-07-28 support; unsupported revision requests follow the actual negotiation/rejection contract, not an invented emulation.

Only scan_target supports task augmentation, under negotiated 2025-11-25. Hosted tasks require a connected OAuth client; API-key/older-protocol clients retain immediate tool-call behavior.

| Identifier   | Lifetime/meaning                    | Follow-up                               |
| ------------ | ----------------------------------- | --------------------------------------- |
| MCP task ID  | Transport task reference            | tasks/get, tasks/result, tasks/cancel   |
| Scan ID      | Durable execution record            | get_scan_status, cancel_scan            |
| Operation ID | Durable mutation/submission outcome | Original-principal operation inspection |

Hosted task state re-authorizes its durable operation/scan binding on each request. Local stdio task listing is process-session state. Polling/cancellation must not mix identifier types.

Hosted responses use no-store and vary on authorization/protocol. Nondelegated writes return connect_required rather than queueing a legacy approvalId cycle.

### 8.4 Agent-registry architecture

The source registry has 51 install entries resolving to 48 preferred surfaces. Duplicate install paths and distinct IDE/CLI/cloud surfaces explain why entry count and preferred count differ.

| Strategy      | Installer contract                                                                 |
| ------------- | ---------------------------------------------------------------------------------- |
| Config-file   | Merge managed entry; preserve unrelated config, permissions and customized content |
| Vendor CLI    | Use the client's supported CLI operation, with preview where defined               |
| Guided manual | Print the exact client-owned setup/activation steps                                |
| Agent Plugin  | Portable artifacts/shims; do not infer client discovery from a copied directory    |

Safe writers refuse symlinks/malformed roots and do not inline raw secrets into conventionally shared files except under the explicit reviewed override/ignore contract. Dry-run is a preview, not authenticated runtime acceptance.

| Support metadata  | Evidence requirement                                              |
| ----------------- | ----------------------------------------------------------------- |
| COMPATIBLE        | Documentation/package-conformance evidence for the setup contract |
| NATIVE / VERIFIED | Retained client-runtime receipt required                          |
| EXPERIMENTAL      | Restricted/unaccepted path; presence is not verification          |
| DEPRECATED        | Compatibility/migration path, not recommended primary setup       |

Verification metadata identifies evidence kind, platform, reference and retained receipt. A public listing is a separate channel readback, not an upgrade inferred from registry inclusion.

Marketplace exports record source revision and file provenance. Update source templates and regenerate under the release workflow rather than manually rewriting hashed generated artifacts.

### 8.5 Scan-quality contract and client parity

The quality projection reads stored scan fields, findings, receipts, manifest references, ingestion warnings and attachments. It emits direct facts, labeled estimates, a version and deterministic checksum.

Receipt ratios and verified-finding ratios are heuristics with a declared denominator; neither estimates missed findings or scanner accuracy. `engine-scope:`/`engine-gap:` metadata is counted separately from observed scanner outcomes.

The checked matrix uses M = measured, D = derived, N = not_reported:

| Metric             | Dashboard | REST v1 | SDK | CLI | MCP | Desktop Local |
| ------------------ | --------- | ------- | --- | --- | --- | ------------- |
| scan_status        | M         | M       | M   | M   | M   | M             |
| finding_count      | M         | D       | D   | N   | N   | M             |
| verification_mix   | M         | D       | D   | N   | N   | M             |
| coverage_receipts  | M         | M       | M   | M   | M   | N             |
| manifest_checksum  | M         | M       | M   | M   | M   | N             |
| ingestion_warnings | M         | D       | D   | N   | N   | N             |
| quality_surface    | M         | M       | M   | M   | M   | N             |

The apparent difference between CLI/MCP finding_count N and quality_surface M is intentional: the ordinary scan projection does not carry every finding metric, but the explicit quality command/tool returns the server-computed projection. Do not claim the bare polling response contains the quality endpoint's full fields.

Desktop's stored verification mix describes local DETECTED observations, not independent hosted verification. Its absent manifest/receipt fields stay N instead of being fabricated from local success.

The surface checksum hashes the quality projection excluding its own checksum field. Equality shows deterministic projection of the supplied evidence; it does not authenticate a production database or certify the scanned application.

### 8.6 API compatibility and disclosure

The documented `/api/v1` policy is additive-only, with breaking alternatives under a new major version and at least 90-day notice for deprecation. The policy also names specific non-prefixed product routes; do not assume every private/dashboard endpoint is part of a uniform public contract.

Optional fields and source validators remain authoritative. New status shapes must be handled without replacing unknown/unsupported evidence with a success fallback.

SDK callers pass bare resource paths; the shared client adds `/api/v1` and rejects already-prefixed paths. Path normalization, idempotency and authorization are different concerns.

## 9. Contract-version registry

| Contract                  | Version                                     | Interpretation                                |
| ------------------------- | ------------------------------------------- | --------------------------------------------- |
| Vibe Security 50          | `vibe-security-50/1.2.0`                    | Control catalog/coverage interpretation       |
| URL scan capabilities     | `url-scan/3.0.0`                            | Six bounded URL/API profiles                  |
| Repository scan depths    | `scan-depths/1.3.0`                         | Cross-language depth/ceiling fixture          |
| Launch Gate               | `lyrashield-gate/2.3.0`                     | Verdict rules                                 |
| Gate assessment           | 2                                           | Immutable release/policy/evidence binding     |
| LyraShield Score          | `lyrashield-score/1.0.0`                    | Pure numeric/grade calculation                |
| AI-Built Failure Taxonomy | `ai-built-failure-taxonomy/1.0.0`           | Eight named review classes                    |
| WebMCP detector/inventory | `webmcp-assurance/2` / `webmcp-inventory/1` | Static analyzer and inventory                 |
| WebMCP runtime            | `lyrashield-webmcp-runtime/1`               | Opt-in browser observations                   |
| AI assurance mapping      | `ai-assurance-mapping/1.0.0`                | Selected OWASP LLM mappings                   |
| Result manifest           | 7 in current source                         | Immutable result/terminal/provenance artifact |
| Launch report payload     | `lyrashield-launch-report/2.0.0`            | Public aggregate disclosure/checksum          |
| Report provenance         | `lyrashield-report-provenance/1.0.0`        | Private issue-time binding                    |
| Scan workflows            | `scan-workflows/1.0.0`                      | Change-review workflow fixture                |
| Scan quality              | `lyrashield-scan-quality/1.0.0`             | Stored-evidence projection/parity             |
| Affiliate terms           | `2026-08-18-v1`                             | Partner acceptance schedule                   |

The Lite Check detector/payload is separately versioned in its owning source and is not a full-scan manifest. A documentation version does not alter executable versions or backfill stored artifacts.

## 10. Technical claims boundary

### 10.1 What the specification establishes

This paper describes source contracts and their interpretation. Pure-function tests can demonstrate expected results for supplied inputs; database tests can demonstrate particular persistence/RLS behavior in their test environment.

A local sandbox/relay test establishes a bounded transport observation. A package-conformance check establishes a packaged schema boundary. Neither is exact-image production deployment or authenticated acceptance by every client.

### 10.2 Explicitly unavailable inferences

- Manifest MATCH is not independent finding verification.
- A signed checksum is not a software security certificate.
- Identity MATCH is not freshness, READY or deployed-release proof.
- NO_FINDING is not a universal pass.
- A completed scanner family is not full-standard compliance.
- A documented framework mapping is not OWASP/NIST endorsement.
- A measured receipt ratio is not detection accuracy.
- A local native boundary does not make remote inference local.
- An experimental client artifact is not an accepted marketplace integration.

Deterministic code has not been formally verified merely because it is deterministic. No formal adversarial-robustness claim is made for model-assisted review.

### 10.3 Dated evidence and unresolved gates

The historical prompt-injection artifact records 42 OWASP cases and 85.7% expected-outcome matching; the separate AILuminate demo observation is not a pass rate. Both are first-party and the removed historical runner prevents clean-checkout reproduction until replaced.

The live safety catalog, source unit tests and that historical evaluation are distinct. None is a universal assessment of customer AI behavior.

Production release/readiness, paid scan acceptance, signing/distribution, reconciliation, provider settlement and client-runtime acceptance require exact dated receipts. The current retest checksum-gap record and source fix must remain separately labeled until deployment evidence closes the gate.

Use [PRD release status](../PRD.md#9-release-status), the [claims policy](./policies.md#public-claims-policy) and [distribution receipts](./marketplace/CLIENT-CONTRACTS.md) before making availability or operational assertions.

## Appendix A — Illustrative contract interactions

These fragments explain fields and decision behavior. They are not complete API schemas, live receipts, executable test instructions or authorization to create work.

### A.1 Three states must not collapse

```text
scan status: COMPLETED
finding tier: DETECTED
control result: NO_FINDING for a different assigned check
```

The combination is valid: completed execution need not independently verify a detection, and one check's absence cannot resolve a different finding.

### A.2 Score and gate can disagree honestly

```text
one unverified open HIGH
score deduction: 10 × 0.25 = 2.5
numeric score: roundHalfUp(97.5) = 98
final grade: A (open HIGH prevents A_PLUS)

complete gate coverage + unresolved HIGH → NOT_READY
missing required gate coverage → INSUFFICIENT_EVIDENCE
```

Arithmetic does not supply missing gate receipts. The same score can accompany different coverage decisions.

### A.3 Signature and identity are separate response fields

An illustrative response fragment, omitting the outer API envelope:

```json
{
  "verified": true,
  "releaseIdentity": { "status": "MISMATCH" }
}
```

The checksum signature can be valid while the caller-supplied release reference differs. The stored identity remains private. A MATCH would still not override expiry or a NOT_READY assessment.

### A.4 Retrying an uncertain submission

```text
submit input I with key K → response lost
retry same I with same K → inspect/reuse existing operation
submit changed I with same K → conflict
submit I with new K → potentially new work, not a recovery proof
```

Operation access stays bound to the originating principal. Do not substitute a new credential to bypass its authorization context.

## Appendix B — Glossary

- **Assessment identity:** retained full commit or artifact digest, separate from worker execution identity.
- **Coverage family:** scanner execution class whose required receipt depends on target/profile.
- **Exact checksum input:** original persisted JSON text, not a new JSONB serialization.
- **Execution provenance:** product revision, immutable worker digest and engine revision bound to the result.
- **Effective state:** current applicability result over immutable historical verdict.
- **Finding lifecycle:** issue/remediation workflow state, not verification tier.
- **Idempotency key:** caller-retained request identity for identical retries, not an authorization grant.
- **Model-declared scope:** bounded engine metadata, not independent coverage measurement.
- **Provider cap:** protected source-defined execution ceiling, not price or expected spend.
- **Scope commitment:** opaque public commitment that does not disclose private repository identity.
- **Share capability:** revocable/expiring token granting the defined report read/confirmation scope.
- **Verification tier:** retained evidence interpretation distinct from confidence and status.

## Appendix C — Source owners

| Contract             | Primary source                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profiles and aliases | [scan-profile.ts](../packages/types/src/scan-profile.ts), [URL capabilities](../packages/types/src/url-scan-capabilities.ts)                                                                                                                  |
| Taxonomy/coverage    | [failure taxonomy](../packages/security/src/ai-built-failure-taxonomy.ts), [Vibe controls](../packages/security/src/vibe-security-controls.ts), [AI controls](../packages/security/src/ai-security/controls.ts)                               |
| Score                | [pure function](../packages/score/src/index.ts), [DB adapter](../packages/db/src/score-service.ts)                                                                                                                                            |
| Gate                 | [evaluator](../packages/gate/src/index.ts), [matrix](../packages/gate/src/coverage-matrix.ts), [applicability](../packages/gate/src/applicability.ts)                                                                                         |
| Manifest/retest      | [checksum verifier](../packages/db/src/manifest-checksum.ts), [retest completion](../apps/worker/src/engine/result-integrity/retest-completion.ts)                                                                                            |
| Fix/merge            | [scope policy](../packages/fix/src/scope-policy.ts), [PR request route](../apps/web/src/app/api/fix-proposals/[id]/create-pr/route.ts), [merge service](../packages/db/src/fix-pr-merge-service.ts)                                           |
| Reports              | [payload](../packages/db/src/launch-report-payload.ts), [service](../packages/db/src/launch-report-service.ts), [provenance](../packages/db/src/launch-report-provenance.ts), [verify route](../apps/web/src/app/api/reports/verify/route.ts) |
| Authorization        | [permissions](../packages/auth/src/permissions.ts), [key service](../packages/db/src/api-key-service.ts)                                                                                                                                      |
| Desktop              | [license](../apps/desktop/src-tauri/src/license/mod.rs), [BYOK](../apps/desktop/src-tauri/src/byok/mod.rs), [child environment](../apps/desktop/src-tauri/src/runtime/spawn.rs)                                                               |
| Distribution         | [MCP catalog](../packages/mcp/README.md), [protocol conformance](../packages/mcp/docs/protocol-conformance.md), [agent registry](../packages/agent-registry/README.md)                                                                        |
| Quality              | [projection and parity](../packages/types/src/scan-quality.ts), [offline corpus](../evals/scan-quality/README.md)                                                                                                                             |
| Safety pack          | [fixed catalog/schema](../packages/types/src/ai-safety-tests.ts)                                                                                                                                                                              |

Source links are review locators, not operational receipts. Deployment-specific identities, secrets and actual provider economics are intentionally omitted.

---

_This specification describes source behavior as of its documentation revision. Executable schemas, services and tested contracts override prose; release evidence governs deployment claims. It is not a certification, a formal-verification proof, a universal security guarantee or authorization to execute paid/production operations._
