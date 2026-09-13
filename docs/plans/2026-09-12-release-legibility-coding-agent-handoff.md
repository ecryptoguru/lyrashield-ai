# LyraShield AI — Release Legibility Coding-Agent Handoff

Date: September 12, 2026

Status: implementation brief for founder review; no implementation, merge, deployment, or public-disclosure approval is implied by creating this document.

Audience: coding agent implementing focused product changes in `lyrashield-ai`.

## 1. Objective and outcome

Make existing release-assurance evidence understandable and correctly bound to the release it describes. Deliver four improvements:

1. Newly issued launch reports evaluate applicability at issue time.
2. Authenticated report readers can identify the original assessed release without changing public disclosure.
3. Launch Readiness supports a target-specific release-reference check.
4. Pricing discloses Local purchase availability before sending visitors to checkout.

These changes improve evidence integrity and usability. They do not add scanner coverage, establish security, enable purchases, or make the dashboard enforce deployments.

When this brief is dispatched for implementation, complete the authorized scope through focused branches, tests, preview evidence, and PRs. The founder merges. Do not deploy, push directly to main, contact customers, submit payments, or enable purchase admission. Public identity verification remains a separately approved phase.

## 2. Source baseline and required reconnaissance

The source review used local revision `370778e5cb34f76b5d57cd444466f0556251246a`. A fetch resolved `origin/main` to `e3fa791f6e92f44262c60c9048810e994d01d341`; the core report, applicability, readiness, billing-admission, and pricing files compared in that review had no differences. This is source evidence, not deployment evidence. Production payment admission was not queried.

Before implementation:

- Read applicable `AGENTS.md`, `PRD.md`, `codebase.md`, and `docs/README.md`.
- Fetch the repository's configured GitHub remote and record the implementation base SHA.
- Inspect status and worktrees. Preserve all user changes. At review time, `docs/security/remediation-handoff-2026-09-11.md` and `dogfood-output/` were untracked; do not remove or stage them.
- Create a focused `codex/` branch in an isolated worktree if the shared checkout has concurrent work.
- Activate the repository in Serena; use symbols and references for substantive source navigation.
- Trace all consumers of the report payload, gate response, report readers, and billing admission before choosing storage or API changes.
- Verify current scripts, dependencies, runtime, and CI. Do not inherit claims that this host lacks `node_modules`, cannot reach the registry, or cannot create PR comments. Those were assumptions in the original external handoff.
- Do not depend on named helper skills/scripts unless they actually exist in the current environment.

Executable code wins over this brief. Resolve routine implementation choices independently. Escalate only a material scope, disclosure, compatibility, or authorization conflict after completing unaffected work.

## 3. Findings that motivate the work

| Current source                                 | Verified behavior                                                                                                                     | Required correction                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/db/src/launch-report-service.ts`     | `generateLaunchReport()` selects a persisted verdict and copies its stored staleness.                                                 | Evaluate applicability when issuing the report, against that exact verdict.         |
| `packages/db/src/launch-report-payload.ts`     | Public payload contains dates, counts, a generic scope statement, and `stale: boolean`; no release identity or applicability reasons. | Keep private provenance separate. Do not accidentally widen the allowlist.          |
| `packages/gate/src/applicability.ts`           | `evaluatedIdentity` becomes the caller-supplied identity when present, including on mismatch.                                         | Do not use it universally as the assessed identity.                                 |
| `apps/web/src/lib/launch-readiness-server.ts`  | Helper accepts a target and expected identity, while the page currently loads all targets without identity.                           | Add target-scoped input and explicit result semantics.                              |
| `apps/web/src/app/buy/local/page.tsx`          | Availability is checked for the request's resolved payment provider.                                                                  | Marketing availability must preserve provider-specific behavior.                    |
| `apps/web/src/app/api/reports/verify/route.ts` | Verification accepts checksum and signature, not a share token.                                                                       | Token-based identity confirmation would be new behavior, not a trivial extra field. |
| `packages/db/prisma/schema.prisma`             | `Report` has optional `scanId` and public report content but no dedicated gate-verdict binding field.                                 | Choose minimal durable private provenance storage after inspecting all serializers. |

## 4. Non-negotiable product contracts

### 4.1 Separate identity, applicability, and readiness

Treat these as independent facts:

- **Assessed identity:** the full commit SHA or supported artifact digest retained in the original assessment snapshot.
- **Requested identity:** the release reference supplied by the user for comparison.
- **Identity comparison:** match, mismatch, cannot confirm, or not requested.
- **Applicability:** whether that assessment remains usable under the existing freshness, policy, newer-attempt, and evidence rules at a stated time.
- **Historical verdict:** the original immutable READY, NOT_READY, or INSUFFICIENT_EVIDENCE result.
- **Effective readiness:** the existing gate's result after applicability rules are applied.
- **Signature verification:** whether the supplied checksum's signature is valid under the trusted signing key. This alone does not establish release match, current applicability, or the safety of the application.

A matching release can be NOT_READY. A matching release can have expired evidence. Missing identity is not a mismatch. A valid signature is not a security guarantee.

### 4.2 Immutable reports and bounded timestamps

- An issued report always describes its original assessment; never join an old report to the latest verdict by target alone.
- Record assessed time, issue time, and applicability-check time with explicit meanings.
- Preserve the existing 24-hour freshness rule and its authoritative timestamp; do not silently reset expiry when issuing a report.
- Existing issued content, checksum, signature, and downloads must not regenerate as a side effect of viewing or changing applicability logic.
- If a separate current-status read is later displayed, label it separately from the frozen issue-time statement.
- A source commit match does not prove that a deployed artifact was built from that commit. Do not imply deployment provenance that the retained evidence cannot establish.

### 4.3 Privacy and ownership

- Keep workspace reads under the existing authorization and RLS boundaries.
- Keep public share-token resolution on the sanctioned server path.
- Public launch content must still pass through `buildLaunchReportPayload()`.
- Do not expose private provenance through generic report serialization, downloads, HTML, API v1, SDK/MCP responses, or shared renderers.
- No secrets, repository coordinates, finding details, model costs, or upstream engine names enter public output.

## 5. Recommended PR sequence

1. **PR 1 — WP-B plus WP-A Phase 1:** durable private report binding, shared applicability evaluation, honest issue-time state, authenticated display, and regression tests. Combining these avoids issuing corrected reports that still lack durable identity provenance.
2. **PR 2 — WP-C:** target-specific release checks, deep links, result states, and browser evidence.
3. **PR 3 — WP-D:** provider-aware Local availability and preview evidence.
4. **Separate decision/PR — WP-A Phase 2:** public online identity confirmation, only after explicit founder approval.

PRs 2 and 3 may be independently reviewable if dependencies permit. Keep commits focused. Do not introduce a new framework, package, generalized report system, or engine change for this work.

## 6. PR 1: report identity and issue-time applicability

### 6.1 Trace and reuse existing logic

Inspect:

- `packages/db/src/gate-service.ts`: single-target and batch applicability readers, snapshot parsing, policy fingerprint inputs, finding and verification change detection.
- `packages/gate/src/applicability.ts`: pure applicability rules and reason codes.
- `packages/db/src/launch-report-service.ts`: issuance and signing flow.
- `packages/db/src/launch-report-payload.ts`: public constructor, checksum, and source types.
- Report creation routes, private/public readers, download routes, shared page components, and their v1 counterparts.

Extract the smallest internal helper that evaluates a specified persisted verdict using the caller's transaction and explicit time. Reuse it where appropriate without changing the public semantics of existing single-target or batch readers. Preserve batch behavior; do not replace a bounded batch query with one query sequence per target.

Do not fetch latest independently for report content and applicability. Select one verdict, evaluate that verdict, and save its binding with the issued report atomically. Define the consistent database observation point and how it maps to `applicabilityCheckedAt`; a transaction alone does not necessarily provide a consistent multi-query snapshot under the default isolation level. Use an existing transaction/isolation pattern or bounded retry strategy, and document the chosen consistency guarantee.

No scans, gate reevaluations, or billable work may be triggered by report applicability reads.

### 6.2 Private provenance storage

Prefer an existing safe private metadata mechanism if one exists. Otherwise use a minimal nullable, additive schema change. Do not put private fields into the signed public `contentJson` just because JSON is convenient.

Retain enough information to establish:

- The original gate-verdict identifier and checksum.
- The supported assessment version and original assessed identity.
- Assessment time and issue-time applicability-check time.
- Applicability outcome and bounded reason codes at issue.

Use the immutable verdict for fields that can be reliably recovered; duplicate only what is required for durable issue-time evidence and the chosen retention contract. Account for verdict/report deletion and retention behavior. Never reconstruct identity from a target's current branch, current settings, or latest scan.

For old reports without a trustworthy binding, show `Release identity unavailable for this report`. Do not guess, silently backfill from latest, or rewrite old signed content. A historical backfill is out of scope unless exact provenance is demonstrably recoverable and separately reviewed.

If schema changes are needed: preserve RLS, use additive forward-only migrations, test preexisting rows, and retain compatibility with the prior deployed application during rollout. Do not run production migrations as part of this handoff.

### 6.3 Applicability and error behavior

Reuse all current applicable reasons, including expired assessment, changed policy, newer assessment attempt, changed evidence, unavailable assessment, and unsupported identity. Identity mismatch requires a requested identity; do not invent one for report issuance merely to satisfy a test count.

Keep stored historical verdict fields untouched. For new public reports, map known non-applicability to `stale: true`. On recomputation failure, either issue an explicitly non-current report with private `unknown` applicability and a safe internal reason code, or fail issuance if the existing model cannot represent the result honestly. Never fall back to old `current: true`.

Do not catch a database error inside an aborted transaction and attempt to continue writing. If an unknown-state report is issued, do so through a valid transaction path with the originally selected binding preserved. Do not store raw exception strings as public or private user-facing reasons; log a bounded diagnostic with `@lyrashield/logger`.

Detailed applicability reasons remain private in this phase. The existing public `stale` boolean remains boolean; introducing a public `unknown` enum, new reason list, or identity field requires an explicit disclosure/schema decision.

Review the public renderer so a historical READY label cannot visually override `stale: true` or an elapsed expiry. Label historical status and issue-time currency clearly without inventing a new security conclusion. Do not edit frozen report bytes to update today's status.

### 6.4 Authenticated report experience

Show on the existing authenticated report detail experience:

- `Assessed release`: kind and full original SHA/digest, with accessible copy control if an existing component supports it.
- `Assessed at`, `Issued at`, and `Applicability checked at`, with timezone clarity.
- `Applicability when issued`: applicable, not applicable, or could not be established; show safe reason text.
- Historical verdict and any existing effective-state presentation with explicit labels.

Do not assume an existing shared component is private merely because it is also rendered for signed-in users. Pass private data only through an authenticated response and component path. Target detail duplication is optional and deferred unless an existing reusable presentation makes it a small, directly useful change.

### 6.5 Acceptance tests

- No intervening changes: applicability agrees with the existing gate evaluator.
- Newer scan attempt, including non-success terminal/in-flight cases under existing rules: appropriate newer-attempt reason.
- Finding update and verification update: evidence-change reason.
- Changed or missing policy: existing fail-closed policy behavior.
- Just before, exactly at, and after freshness expiry: authoritative boundary behavior.
- Unsupported/missing legacy snapshot: unavailable/cannot-confirm state.
- Recompute failure: no silent current/READY fallback; valid transaction behavior.
- A concurrent newer verdict cannot mix report counts from one verdict with identity/applicability from another.
- Matching commit and artifact-bound examples preserve full original identity.
- An old report still displays its original identity after a newer assessment exists.
- Legacy reports remain readable with explicit unknown identity.
- Cross-workspace access is denied; private provenance never appears in public API, shared HTML, or downloads.
- Existing saved payload/checksum/signature fixtures remain unchanged.
- Public key-set regression remains unchanged for private binding. New issuance may change `stale`, timestamps, checksum, and signature as required by WP-B; do not assert all newly issued payloads are byte-identical.
- Existing signing/verification tests continue to pass, including unsigned behavior where currently supported. Do not change signing policy incidentally.

## 7. PR 2: target-specific release-reference check

### 7.1 Input and server contract

Use the current Launch Readiness page and shared components. Add a target selector or a release input within a target's card. Prefer the smallest option consistent with existing navigation.

Support a target-scoped URL such as:

```text
/dashboard/launch-readiness?targetId=<id>&commit=<full-sha>
/dashboard/launch-readiness?targetId=<id>&artifactDigest=<supported-digest>
```

Reuse existing identity validation schemas. Accept full supported identifiers; do not resolve branches, tags, or abbreviated prefixes as exact release identity. Trim permitted whitespace and normalize only as allowed by the canonical validator. Reject simultaneous commit and artifact digest, repeated/ambiguous query values, malformed input, and unsupported formats with inline feedback.

If identity is provided without a target, auto-select only when there is exactly one authorized target; otherwise request target selection without applying the identity across all targets. Never expose another workspace's target through a query parameter.

Wire the input through `getGateReadinessTargets()` and the existing server/API path. Preserve query state through submission, refresh, and Back/Forward. Clear stale match results when target/input changes or a request fails. An error must not leave a previous success presented as the current check.

Keep requested and assessed identities separate in the read model. Preserve existing external `evaluatedIdentity` behavior unless a separately reviewed compatibility change is necessary. Inspect SDK, MCP/WebMCP, and API v1 consumers before changing shared response types.

### 7.2 User-visible semantics and copy

Field label: `Check a specific release (optional)`.

Helper: `Choose a target and paste the full commit SHA or artifact digest for the release you want to check.`

Empty-reference note: `Without a release reference, this view is informational. It shows what the latest assessment covers; it does not check a specific release.`

| State                                        | Required presentation                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Identity matches                             | `Release reference matches this assessment.` Show actual assessed identity.                     |
| Identity differs                             | `This assessment covers a different release.` Show requested and assessed identities privately. |
| Identity type unsupported or binding missing | `Cannot confirm this release from the retained assessment.`                                     |
| Matching identity, expired evidence          | Show match plus expiry; effective readiness stays insufficient under existing rules.            |
| Matching identity, NOT_READY verdict         | Show match plus blocking findings; never render a green readiness pass.                         |
| No reference                                 | Informational note and existing label-mode behavior.                                            |
| Check fails                                  | Explicit unavailable/error state with retry; no retained success.                               |

Add the existing reason-specific next action where available: inspect blocking findings, inspect an in-progress assessment, or open scan creation. Opening a scan form must not submit a scan. Preserve approval, entitlement, and billing gates.

This is an identity-checked read. Do not label it an enforced deployment gate, claim that it blocks releases, or alter no-identity API/CLI semantics.

### 7.3 Acceptance and browser evidence

Test correct and wrong full SHA, supported artifact digest, unsupported identity kind, missing binding, matching-but-expired, matching-but-NOT_READY, no verdict, empty input, invalid input, conflicting parameters, and cross-workspace target IDs.

Verify direct links, refresh, clear, target switching, Back/Forward, and error recovery. Confirm no verdict creation, scan enqueue, report creation, or billing mutation occurs on input submission.

Capture privacy-safe desktop and mobile preview evidence for at least: informational state, match/current, mismatch, match/expired, and cannot-confirm. Verify keyboard submission, focus, field labels, status announcements, readable full identifiers, and no horizontal overflow. A screenshot alone is not functional proof; include the exercised interaction and expected result.

## 8. PR 3: Local purchase availability on pricing

### 8.1 Source of truth and deployment contract

Trace `getLocalBillingAdmission()`, request provider resolution, the buy page, checkout routes, and marketing deployment before editing. Reuse the provider-aware decision instead of introducing independent business logic.

Marketing and the authenticated app run separately. Define how marketing receives current availability. Prefer an existing public configuration mechanism; otherwise a minimal read-only availability response can return only the display state needed by pricing. Do not expose secrets, raw environment configuration, account data, or operational diagnostics.

Match the provider/region behavior used by checkout, including unknown-region fallback. Do not equate `Polar enabled OR Razorpay enabled` with availability for every visitor. Any cache must account for routing context, use an explicit bounded freshness policy, and avoid reusing one region's availability for another.

If deployment-time configuration is chosen instead of a runtime read, document the coordinated refresh requirement and test it. Do not promise automatic switching without an actual propagation mechanism. Checkout remains authoritative and must recheck admission.

### 8.2 Presentation

- Confirmed unavailable: `Local licenses are not available for purchase yet.`
- Secondary line: `You can still create an account and run the Cloud trial.` Verify the current trial eligibility copy before shipping; do not imply every existing account receives another trial.
- CTA: `Create an account`, linking directly to `https://app.lyrashieldai.com/sign-up`.
- Confirmed available for the selected provider: preserve the existing buy CTA and prices.
- Availability unknown/unreachable: `Local purchase availability could not be confirmed.` Provide retry or a clearly labeled availability-check link; never falsely assert purchase availability or definitive closure.

Do not change prices, plans, allowances, packs, admission flags, provider setup, or billing ownership.

### 8.3 Acceptance and browser evidence

Test both providers off, both on, Polar-only, Razorpay-only, unknown routing context, and availability-read failure. Exercise all preview states through real rendering, including any cache/region variation. Verify the final buy page agrees with the marketing result for the same routing context.

Capture desktop/mobile unavailable and available states plus unknown-state evidence. Confirm no price changes, no misleading initially visible buy CTA, no payment submission, and no admission mutation.

## 9. Deferred WP-A Phase 2: public identity confirmation

Recommendation: prefer online verifier-only confirmation to a public 12-hex identity prefix. A prefix is not an opaque privacy boundary and is not full identity proof.

Do not implement this phase until the founder approves the disclosure and endpoint contract. Prepare a bounded proposal describing:

- Existing verification accepts `reportChecksum` and `signature`; retain that compatibility.
- A new explicit verification mode or endpoint would resolve a valid report share token and the report's immutable private binding.
- Confirm only the caller-supplied full identity; do not return the stored identity on mismatch.
- Validate token/report association, expiry, revocation, deletion, and payload integrity as appropriate to the advertised guarantee.
- Return distinct outcomes for signature verification and identity confirmation. `confirmed` means identity match only; it must not mean READY, current, deployed, or secure.
- Treat legacy unbound reports, malformed inputs, unavailable provenance, and invalid access as cannot-confirm or the existing safe error contract. Avoid existence leaks.
- Preserve existing rate limiting and assess per-token abuse limits, enumeration of known commits, response caching, and token redaction from logs.
- Do not mint tokens as part of verification.

This would provide an online server assertion about private provenance. It would not make release identity independently verifiable from the existing signed public payload alone. If offline cryptographic identity binding becomes a requirement, propose a separately versioned signed format with a reviewed disclosure/commitment design.

Estimate implementation only after tracing token resolution and report storage. Do not label this phase a trivial extension or claim the current endpoint already supports tokens.

## 10. Verification and evidence gates

Use existing test infrastructure and focused regression coverage. Final tests, builds, diffs, migration checks, and release evidence must run raw; RTK is optional for noisy iterative diagnostics only.

Relevant existing suites include:

- `packages/gate/src/applicability.test.ts`
- `packages/db/src/gate-applicability-service.test.ts`
- `packages/db/src/launch-report-payload.test.ts`
- `packages/db/src/launch-report-signing.test.ts`
- `apps/web/src/lib/launch-readiness-server.test.ts`
- `apps/web/src/lib/launch-readiness.test.ts`
- Private/shared report route tests and affected billing/marketing tests.

At this baseline, root scripts include `pnpm test:core`, `pnpm test:marketing`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test:e2e`. Discover the correct focused invocation from current package/test configuration rather than assuming every suite runs from one directory.

Run the relevant focused tests first, then affected package lint/typecheck/build, formatting on changed files, and `git diff --check`. For schema changes, also run generated-client validation, migration replay/drift checks, backward-compatibility checks, and relevant RLS tests against an isolated database. Do not use production for these tests.

Record independently:

1. Source base and final commit SHA.
2. Local checks and exact commands/results.
3. Fresh CI results for the PR head.
4. Preview commit/environment and rendered interaction evidence.
5. Founder merge status.
6. Deployment and live verification status, normally pending because this brief does not authorize deployment.

If a check is blocked, name the observed blocker, the strongest substitute run, and what remains unverified. Do not infer passing tests from compilation, passing UI from screenshots alone, or deployment from green CI.

## 11. Documentation and delivery

Update only affected truth documents when behavior lands: typically `codebase.md`, `docs/user-guide.md`, and relevant `PRD.md`/`AGENTS.md` status. Do not mark proposed work deployed. After an authorized merge, remove obsolete branch-only wording in affected current summaries and preserve detailed history in Git/PRs.

Keep generated screenshots/logs out of committed source unless repository policy explicitly permits them. Store privacy-safe evidence in the existing ignored artifact location or attach it to the PR. Redact tokens, private repository details, account identifiers, and secrets.

Each PR description must state the concrete before/after behavior, private/public data delta, compatibility/migration impact, focused verification, and remaining gates. No memory citations belong in PR descriptions.

Final coding-agent handback:

```text
Work package:
Status: implemented / deferred / blocked
Branch and final SHA:
PR URL:
Behavior delivered:
Files changed:
Private/public contract delta:
Migration and rollback compatibility:
Local verification:
CI URL and verdict for exact head:
Preview evidence and commit:
Remaining gaps:
Merge/deployment status:
Founder decision required, if any:
```

Completion means all dispatched first-phase behavior is implemented, regression-tested, rendered where applicable, and submitted as reviewable PRs with honest evidence. Phase 2 may remain explicitly deferred. Do not expand this work into pricing changes, scanner additions, new analytics, recipient accounts, comments, acceptance stamps, push-driven invalidation, or production payment operations.
