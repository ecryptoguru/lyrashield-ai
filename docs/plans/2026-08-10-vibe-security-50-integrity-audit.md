# Vibe Security 50 integrity audit

Date: 2026-08-10
Audited contract: `vibe-security-50/1.0.0`
Repair contract: `vibe-security-50/1.1.0`

## Decision

Keep the 50-item registry, but stop treating it as 50 equivalent vulnerability tests. It is a release-assurance control catalog with four execution classes:

- 5 deterministic checks: 3, 27, 29, 37, 45.
- 10 hybrid checks: 1, 2, 14, 20, 28, 31, 32, 38, 39, 47.
- 28 engine-led reviews: 4-13, 15-19, 21-26, 30, 33, 40-42, 44, 49.
- 7 evidence-required controls: 34-36, 43, 46, 48, 50.

“Requested,” “scanner completed,” “no finding,” and “verified” must remain different states. Version 1.0 inferred too much from scanner-family completion and did not have an engine artifact capable of proving a negative per-control outcome.

## Confirmed failures

| Area                       | Confirmed behavior                                                                                                                                                                                                 | User impact                                                                                                         | Repair                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Finding-to-control mapping | URL, secret, and agent-config findings generally omitted `control_ids`; only SCA consistently mapped its finding.                                                                                                  | A visible finding could coexist with a “NO FINDING” receipt for the same control.                                   | Map producer-owned deterministic findings to controls 3, 27-29, 31-32, 45, and 47.                                                               |
| Hybrid outcome inference   | An unmatched hybrid control fell through to “NO FINDING” when a broad scanner family completed.                                                                                                                    | A homepage fetch could look like a clean CORS, cookie, IDOR, or OAuth check.                                        | Unmatched hybrid controls are `INCONCLUSIVE`; only a mapped finding establishes `DETECTED`.                                                      |
| Public client keys         | Supabase anon/publishable keys and Firebase client keys were reported as vulnerabilities even though both platforms document them as public identifiers protected by RLS/Security Rules.                           | High-noise findings teach developers to hide the wrong value instead of fixing authorization.                       | Report only Supabase secret/service-role material and precise secret formats; remove public-key findings.                                        |
| Speculative URL heuristics | Numeric IDs were treated as IDOR, dynamic redirects as open redirects, HTML webhook mentions as missing signature verification, and builder attribution as a security finding.                                     | False positives with remediation that could not be justified by retained evidence.                                  | Delete these detectors. Their controls stay engine-led or hybrid/inconclusive until an authorized test can establish the behavior.               |
| CORS claim                 | `Access-Control-Allow-Origin: *` plus credentials was described as browser-exploitable, although browsers block credentialed reads with wildcard origin.                                                           | Incorrect exploit guidance.                                                                                         | Delete the passive claim. Add an origin-reflection test only when the scanner can send controlled `Origin` requests to an in-scope API endpoint. |
| Scorecard coverage gate    | A schema-drift fix changed the “complete” comparison from `COMPLETED` to `PARTIAL`. Control receipts also made the all-receipt gate permanently fail because evidence-required controls are intentionally blocked. | New scorecards could remain unshareable despite complete scanner execution.                                         | Gate on scanner-family receipts only and accept `COMPLETED`/`NOT_APPLICABLE`.                                                                    |
| Report coverage totals     | Report generation counted `PARTIAL` as completed and mixed 5 family receipts with 50 control receipts.                                                                                                             | Incorrect totals in immutable reports.                                                                              | Count only `vibe-*` control receipts and treat only `COMPLETED` as completed.                                                                    |
| Engine contract            | The engine can attach `control_ids` to findings, but emits no per-control assessment artifact.                                                                                                                     | “43 controls requested” cannot become “43 controls tested”; unmatched engine controls are necessarily inconclusive. | Add a validated `control_assessments.json` producer/consumer contract before making stronger coverage claims.                                    |
| Evidence UX                | Seven controls say evidence is required, but there is no control-evidence submission, review, expiry, or attestation workflow.                                                                                     | The UI presents a dead end and marketing copy overstates retained evidence.                                         | Until the workflow exists, describe these as outside-scan requirements. Then add scoped evidence records and accountable review.                 |

## Control-by-control capability

| Rank(s) | Current defensible capability                                                                       | Missing capability for a stronger outcome                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Engine/source review can identify RLS configuration evidence.                                       | Supabase metadata/policy introspection or supplied schema plus explicit table/policy coverage. A public anon key is not evidence of missing RLS.            |
| 2       | Engine can report an authorization flaw with a code path or validated request.                      | Seeded owner/non-owner identities and repeatable object-access mutations. Numeric IDs alone do not prove IDOR.                                              |
| 3       | Repository secret patterns and precise privileged-key formats; public-response secret formats.      | Git-history coverage must be explicitly recorded when gitleaks/trufflehog does or does not run.                                                             |
| 4-10    | Engine-led authentication/session/source review.                                                    | Per-control assessment records, framework-aware fixtures, and authorized identity flows for negative assurance.                                             |
| 11-13   | Engine-led injection/XSS/validation findings.                                                       | Deterministic SAST/DAST receipts with route/source scope and a negative corpus.                                                                             |
| 14      | Passive response headers are observable; no vulnerability is inferred.                              | Controlled-origin preflight/simple requests against discovered in-scope API endpoints, including reflection and credential behavior.                        |
| 15-19   | Engine-led source and authorized interaction.                                                       | Framework-aware CSRF, SSRF, upload, traversal, and command-injection harnesses with safe payload policy.                                                    |
| 20      | Engine-led callback and allowlist review.                                                           | Registered redirect inventory plus controlled callback mutation. Dynamic assignment is not proof.                                                           |
| 21-22   | Engine-led rate-limit/account-enumeration analysis.                                                 | Bounded authorized request sequences, response normalization, and explicit destructive-test limits.                                                         |
| 23      | Engine-led webhook handler review.                                                                  | Framework/provider-aware signature verification rules and safe forged-event rejection tests. Public bundle text cannot prove server verification is absent. |
| 24-26   | Engine-led business-logic review.                                                                   | Seeded entitlement/payment states, idempotency keys, concurrency harnesses, and strict non-charge safeguards.                                               |
| 27      | Exact headers on the fetched response, mapped to the control.                                       | Route inventory; CSP directive quality; `frame-ancestors` equivalence; API versus document scope.                                                           |
| 28      | Flags observed sensitive cookies missing attributes; otherwise inconclusive.                        | Authenticated cookie issuance and logout/rotation flows across relevant hosts.                                                                              |
| 29      | Cleartext HTTP observed in the validated redirect chain.                                            | TLS version/cipher/certificate checks if “weak TLS” remains in scope.                                                                                       |
| 30      | Engine-led public-resource/config review.                                                           | Provider-authorized bucket/database policy introspection.                                                                                                   |
| 31      | A stack trace in the fetched response is evidence; absence on the landing response is inconclusive. | Safe error-trigger matrix and debug-route discovery.                                                                                                        |
| 32      | A source-map reference is a signal, not proof the map is downloadable.                              | SSRF-safe fetch of the referenced map, content validation, and artifact leakage classification.                                                             |
| 33      | Engine-led logging/analytics source review.                                                         | Sink-aware taint rules and supplied production logging configuration.                                                                                       |
| 34-36   | Outside-scan evidence required.                                                                     | Audit-log sampling, alert test receipt, and dated restore-test evidence with reviewer and expiry.                                                           |
| 37      | Manifest discovery, dependency resolution, OSV lookup, and bounded coverage issues.                 | Ecosystem lockfile completeness and explicit reachability where claimed.                                                                                    |
| 38      | SCA/engine can raise package provenance concerns.                                                   | Registry existence, namespace/typosquat, install provenance, and maintainer-risk evidence.                                                                  |
| 39      | Engine can review install scripts and supply-chain configuration.                                   | Sandboxed install behavior and policy-aware lifecycle-script execution evidence.                                                                            |
| 40-42   | Engine-led AI prompt/tool review.                                                                   | Prompt-flow fixtures, untrusted-content injection corpus, and effective MCP permission enumeration.                                                         |
| 43      | Outside-scan evidence required.                                                                     | Deployment sandbox profile and effective egress-policy proof.                                                                                               |
| 44      | Engine-led destructive-permission review.                                                           | Effective production IAM/tool permission inventory and approval-path tests.                                                                                 |
| 45      | Bounded instruction-file patterns with file/line evidence.                                          | Parser-aware instruction precedence and broader client file inventory.                                                                                      |
| 46      | Outside-scan evidence required.                                                                     | Independent oracle/mutation-testing evidence and accountable review of generated tests.                                                                     |
| 47      | Specific GitHub `pull_request_target`/write-permission patterns with file/line evidence.            | Reusable workflow data flow, action pinning/provenance, and other CI providers.                                                                             |
| 48      | Outside-scan evidence required.                                                                     | Agent graph, delegated scope, tool/credential propagation, and child-output trust evidence.                                                                 |
| 49      | Engine-led placeholder/silent-failure review.                                                       | Contract tests or supplied business invariants that distinguish intentional stubs from release defects.                                                     |
| 50      | Outside-scan evidence required.                                                                     | Named reviewer, threat model artifact, review decision, scope, date, and expiry.                                                                            |

## Proper target contract

The next architecture should make each scanner return assessments, not let the orchestrator infer them from missing findings:

```ts
type ControlOutcome =
  "DETECTED" | "NO_FINDING" | "INCONCLUSIVE" | "NOT_APPLICABLE" | "BLOCKED" | "EVIDENCE_REQUIRED"

type ControlAssessment = {
  controlId: `vibe-${string}`
  outcome: ControlOutcome
  method: string
  subjects: string[]
  evidenceRefs: string[]
  findingIds: string[]
  limitations: string[]
  assessorVersion: string
}
```

Rules:

1. A scanner emits one assessment for every control it actually attempted.
2. `NO_FINDING` requires subjects and method; scanner-family completion is insufficient.
3. `DETECTED` requires at least one finding/evidence reference and consistent `control_ids`.
4. The engine writes a schema-validated assessment artifact; absent or malformed entries become `INCONCLUSIVE`.
5. The orchestrator merges assessments by control and preserves conflicts/limitations rather than overwriting them.
6. Immutable reports snapshot the assessment artifact and registry version.

## Verification program

Build a versioned corpus before promoting any control to deterministic `NO_FINDING`:

- At least one positive, one negative, and one adversarial/near-miss fixture per deterministic rule.
- Auth/business controls use seeded role/state pairs and safe request scripts.
- Track precision, recall, unsupported inputs, and runtime by control and framework.
- A detector cannot ship on a title/regex unit test alone; its negative and near-miss fixtures are release gates.
- Live scans remain separate proof and run only against approved targets.

## UX/DX target

- Default to four actionable groups: needs attention, no issue found in stated scope, needs evidence, and not assessed.
- Show method, subject, limitation, and next action before raw scanner internals.
- Do not make users expand 50 rows to understand whether the scan was useful.
- Evidence-required rows need a real add/review/expire workflow; until then, link to required proof and label them outside-scan.
- Developer output (CLI/MCP/API) should expose the same assessment schema and stable control IDs as the dashboard.

## Primary references used for the detector corrections

- Supabase: publishable/anon keys are public identifiers; RLS and grants protect data. <https://supabase.com/docs/guides/database/secure-data>
- Firebase: Firebase API keys are public by design and authorization is enforced by Security Rules/IAM/App Check. <https://firebase.google.com/docs/projects/api-keys>
- MDN CORS: browsers block credentialed response access when `Access-Control-Allow-Origin` is `*`. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS>
- OWASP ASVS 5.0: use explicit verification requirements as the basis for testing technical controls. <https://owasp.org/www-project-application-security-verification-standard/>
