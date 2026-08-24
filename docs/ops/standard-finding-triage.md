# Standard Finding Triage — OnboardingAI2 Acceptance Scan

## Scope and claims boundary

This document records the retained finding inventory for Standard scan
`cmt35aj1s000001hck9fmguzk` against
`ecryptoguru/OnboardingAI2@1689f3607d68764e09769535df8e368c4d5ad2fe`.
It is a triage handoff, not a validation report, remediation record, or clean
security claim.

The scan completed with 24 open findings: 17 recorded as `DETECTED` and 7 as
`INCONCLUSIVE`. All 24 have `verified=false`; zero were independently verified.
The AI App Security layer reached its historical 200-file bound, so absence of
additional findings does not establish complete repository coverage.

Recorded manifest checksum:
`5813c6dc06bcb89b2386cb80563a93e928be96bfe7371a85c930704127606dec`.

## Retained findings

The rows below preserve the displayed order and evidence state. Repeated titles
are separate retained rows. The retained local inventory does not expose enough
per-row metadata to bind repeated rows to exact paths or finding IDs, so no path
or ID is inferred.

|   # | Title                                                                 | Severity | CWE           | CVSS | Evidence state | Verified | Status |
| --: | --------------------------------------------------------------------- | -------- | ------------- | ---: | -------------- | -------- | ------ |
|   1 | Admin authorization fails open when `ADMIN_EMAILS` is unset           | CRITICAL | CWE-306       |  9.6 | `INCONCLUSIVE` | false    | `OPEN` |
|   2 | Authenticated users can overwrite or delete arbitrary proposals by ID | CRITICAL | CWE-639       |  9.6 | `INCONCLUSIVE` | false    | `OPEN` |
|   3 | Admin authorization fails open when `ADMIN_EMAILS` is unset           | CRITICAL | CWE-863       |  9.9 | `INCONCLUSIVE` | false    | `OPEN` |
|   4 | Authenticated bulk insertion bypasses website URL safety validation   | CRITICAL | CWE-918       |  9.1 | `INCONCLUSIVE` | false    | `OPEN` |
|   5 | Shared API-key settings are writable by any authenticated user        | CRITICAL | CWE-862       |  9.6 | `INCONCLUSIVE` | false    | `OPEN` |
|   6 | Private Key (PEM) in `convex/lib/googleCalendar.ts:48`                | CRITICAL | CWE-321       |  9.5 | `DETECTED`     | false    | `OPEN` |
|   7 | Tool command execution lacks explicit approval                        | HIGH     | CWE-250       |  7.5 | `DETECTED`     | false    | `OPEN` |
|   8 | Tool command execution lacks explicit approval                        | HIGH     | CWE-250       |  7.5 | `DETECTED`     | false    | `OPEN` |
|   9 | Tool command execution lacks explicit approval                        | HIGH     | CWE-250       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  10 | Tool command execution lacks explicit approval                        | HIGH     | CWE-250       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  11 | Tool command execution lacks explicit approval                        | HIGH     | CWE-250       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  12 | Tool command execution lacks explicit approval                        | HIGH     | CWE-250       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  13 | Tool command execution lacks explicit approval                        | HIGH     | CWE-250       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  14 | Tool command execution lacks explicit approval                        | HIGH     | CWE-250       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  15 | Tool command execution lacks explicit approval                        | HIGH     | CWE-250       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  16 | Tool command execution lacks explicit approval                        | HIGH     | CWE-250       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  17 | Raw AI prompt or response logged                                      | HIGH     | CWE-532       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  18 | Raw AI prompt or response logged                                      | HIGH     | CWE-532       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  19 | Raw AI prompt or response logged                                      | HIGH     | CWE-532       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  20 | Raw AI prompt or response logged                                      | HIGH     | CWE-532       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  21 | Raw AI prompt or response logged                                      | HIGH     | CWE-532       |  7.5 | `DETECTED`     | false    | `OPEN` |
|  22 | Unbounded agent permissions                                           | HIGH     | Not displayed |  7.5 | `DETECTED`     | false    | `OPEN` |
|  23 | Authenticated users can mutate arbitrary outreach sequences by ID     | HIGH     | CWE-639       |  8.5 | `INCONCLUSIVE` | false    | `OPEN` |
|  24 | Global university migration is exposed to every authenticated user    | HIGH     | CWE-862       |  8.5 | `INCONCLUSIVE` | false    | `OPEN` |

Summary by recorded state:

- `DETECTED`: findings 6–22 (17 total).
- `INCONCLUSIVE`: findings 1–5 and 23–24 (7 total).
- Independently verified: 0.
- Retest-confirmed: 0.
- Open: 24.

`DETECTED` means a scanner retained a candidate with provenance. It does not
mean the condition was independently reproduced or exploit-validated.
`INCONCLUSIVE` means the retained evidence cannot establish the asserted
condition or its absence. Neither state records remediation.

## Evidence required for trusted triage

Trusted per-finding classification remains blocked until an authorized,
redacted export provides:

1. All 24 `Finding` rows, including finding ID, title, description, category,
   CWE, severity, confidence, status, verification state and reason, dedupe key,
   technical detail, and code locations.
2. All 24 `FindingCandidate` rows, including candidate ID, finding ID, scanner
   source, candidate payload, evidence hash, and dedupe key.
3. All 24 `FindingVerification` rows, including receipt ID, candidate and
   finding bindings, method, outcome, reason, checksum, and evidence reference.
4. Associated `Evidence` rows and private objects, including checksum,
   encryption-key reference, redaction status, successful retrieval proof, and
   workspace-isolation proof.
5. The historical AI App Security discovery receipt with the exact 200 scanned
   paths, eligible and skipped counts, representative skipped paths, limits
   reached, and scanner contract version.
6. Canonical verification of the stored manifest checksum. Re-serializing
   fetched JSON with a generic serializer is not canonical verification and a
   mismatch from that method is not evidence of tampering.

Until these records are bound to the exact scan and source revision, repeated
deterministic rows must remain distinct but path-unassigned. Source inspection
may prioritize investigation, but it must not silently change a retained
finding's evidence state.

## Trusted retest criteria

A fix or closure claim requires a fresh, server-owned retest that:

1. Derives its target and scope from the original finding and approved source
   scan rather than accepting a client-selected replacement.
2. Records the exact retest revision, scanner and contract versions, applicable
   inputs, coverage counts, limits, and terminal scan state.
3. Uses the originating deterministic check when applicable and completes all
   coverage needed to evaluate the original condition.
4. Persists a checksum-bound retest receipt and required private evidence
   through the normal evidence-storage boundary.
5. Produces `VALIDATED` only when a complete deterministic retest establishes
   that the original condition is absent within the recorded scope.
6. Leaves incomplete, bounded, blocked, failed, or engine-only absence as
   `INCONCLUSIVE`.

Independent verification remains a separate evidence state and requires a
separate trusted verification receipt. A passing retest must not be relabeled
as independent verification.
