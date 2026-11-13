---
name: fix-and-retest
description: "Use when the user asks to review finding evidence, prepare a fix proposal and verify an applied fix."
---

# Fix and retest

1. Retrieve findings with `lyrashield_get_findings` in the selected workspace. Follow every `nextCursor` with `cursor` before claiming the result set is complete.
2. Use `lyrashield_explain_finding` and `lyrashield_generate_fix_plan` with the selected workspace and finding ID. Keep detection, confidence and verification states distinct.
3. Treat a generated plan as a proposal. Persist one with `lyrashield_record_fix_proposal` only when the user asks to record it; never treat a proposal as a verified fix. Create and retain one unique `idempotencyKey` for recording the proposal and reuse it for identical retries.
4. After the user confirms that a fix was applied, call `lyrashield_verify_fix` with `workspaceId` and `findingId`. Create and retain a separate unique `idempotencyKey` for this retest and reuse it for identical retries.
5. Retain the returned retest scan identifier. Poll `lyrashield_get_scan_status`, starting after 2 seconds and doubling the delay up to 30 seconds, for at most 20 checks or until terminal. Return the identifier if polling or the session ends first and resume that retest later. Preserve `FIXED_PENDING_RETEST`, `DETECTED`, `INCONCLUSIVE` and `INSUFFICIENT_EVIDENCE` exactly as reported. Claim validation only when the trusted retest evidence establishes it.

Do not create a pull request, merge or deploy unless the user separately requests that action and the server-authorized workflow supports it.
