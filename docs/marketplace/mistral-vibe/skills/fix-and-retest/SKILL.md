---
user-invocable: true
name: fix-and-retest
description: "Review finding evidence, prepare a fix proposal, and verify an applied fix."
---

# Fix and retest

1. Retrieve findings with `lyrashield_get_findings` in the selected workspace. Follow every `nextCursor` with `cursor` before claiming the result set is complete.
2. Use `lyrashield_explain_finding` and `lyrashield_generate_fix_plan` with the selected workspace and finding ID. Keep detection, confidence, and verification states distinct.
3. Treat a generated plan as a proposal. Persist one with `lyrashield_record_fix_proposal` only when the user asks to record it; never treat a proposal as a verified fix.
4. After the user confirms that a fix was applied, call `lyrashield_verify_fix` with `workspaceId` and `findingId`. Reuse the same idempotency key for an identical retry when exposed by the tool.
5. Poll the returned retest scan with `lyrashield_get_scan_status` to a terminal state. Preserve `FIXED_PENDING_RETEST`, `DETECTED`, `INCONCLUSIVE`, and `INSUFFICIENT_EVIDENCE` exactly as reported. Claim validation only when the trusted retest evidence establishes it.

Do not create a pull request, merge, or deploy unless the user separately requests that action and the server-authorized workflow supports it.
