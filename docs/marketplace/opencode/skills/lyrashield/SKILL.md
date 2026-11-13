---
name: lyrashield
description: Run LyraShield security scans, review findings and drive the fix → verify loop.
---

## Pre-PR check

1. Run lyrashield_check_diff on the staged changes to identify security issues introduced by this work item.
2. Review any findings before committing.
3. If findings are reported, address them or document why each is acceptable.

## Post-fix verification

1. After applying a fix for a security finding, run lyrashield_verify_fix with the finding ID.
2. Poll the returned retest scan to a terminal state, then include its outcome and scan reference in the PR description.
3. Call the result independently verified only when a separate independent-verification receipt exists.

## Scope limits

- Only run security checks against targets that are owned by this workspace and explicitly listed as authorized targets in the LyraShield settings.
- Do not run checks on files or URLs you do not have permission to scan.
- Do not run scans against third-party URLs or repositories without explicit authorization.

## Honesty clause

A clean check result does not guarantee the absence of all vulnerabilities. A passing check is not a guarantee of zero vulnerabilities.

## Review-depth guide

Fixes are proposals. Authorized workflows execute within connection permissions; pull requests never auto-merge.

Use a stable idempotency key for each intended mutating action and reuse it for identical retries.
Reuse a returned scan or operation ID instead of starting another action. For findings, follow
nextCursor with lyrashield_get_findings(cursor=...) until it is absent; a partial page is
not a complete review. Poll scan and operation status starting at five seconds, back off up to
30 seconds, stop on a terminal state and return the resumable ID after a bounded session.
Treat failed, cancelled, inconclusive and insufficient-evidence states explicitly.

Deeper modes consume more compute and take longer. Choose the least intensive goal and mode that answer the user's request.

| User intent | Goal | Mode | When to use |
| --- | --- | --- | --- |
| "Check this diff before I commit" / "Pre-PR check" | CHECK_PR | QUICK | Fast, bounded release review. Use STANDARD only if the user asks for a thorough pre-PR review. |
| "Quick check" / "Is this file safe?" | TEST_APP | QUICK | Fastest bounded repository scan. |
| "Review this repo" / "Standard security review" | TEST_APP | STANDARD | General code review. This is the default for general review. |
| "Launch review" / "Ready to ship?" | LAUNCH_REVIEW | STANDARD | Launch gating. |
| "Repository pentest" / "Deep security scan" | FULL_PENTEST | DEEP | Intrusive agentic testing inside the authorized isolated repository sandbox. Never reinterpret this as permission to attack a live URL or API. |
| "Compliance review" | COMPLIANCE_REVIEW | DEEP | Compliance / audit use case. |
| "Weekly monitor" / "Re-check this" | WEEKLY_MONITOR | QUICK | Recurring lightweight check. |

If the user does not specify a mode, default to QUICK for pre-PR checks and STANDARD for general reviews. Only use DEEP when the user asks for a deep or compliance review.

## Example prompts and tool calls

Match the workflow to the user's explicit request:

- A question about connecting or access: use `lyrashield_list_workspaces` and `lyrashield_list_targets` only.
- "Check this diff" / "Review my changes": use the read-only advisory `lyrashield_check_diff`; it is not a recorded scan.
- "Run a Quick scan" / "Scan this project": use `lyrashield_get_scan_eligibility` as an advisory preflight, then `lyrashield_scan_target` or `lyrashield_run_pr_scan` only when requested.
- "Explain this finding" / "How should I fix it?": use `lyrashield_explain_finding` and `lyrashield_generate_fix_plan` with the selected workspace and finding.
- "I applied the fix": use `lyrashield_verify_fix` with `workspaceId` and `findingId`, poll the returned retest scan to a terminal state and include its outcome and scan reference. Call it independently verified only when a separate independent-verification receipt exists.
- "Is this target ready to ship?": use `lyrashield_get_launch_readiness` for the selected workspace and target, bound to the supplied commit or artifact digest when available.

Read the connected client's current tool schema before building arguments. Tool availability can differ by client; never invent an operation or field, and never replace a missing tool with a guessed API call.

## Depth and runtime awareness

Deeper modes consume more compute and take longer. Choose the least intensive mode that answers the user's question. Do not run DEEP scans for quick checks, and avoid re-running the same scan repeatedly. When in doubt, ask the user which depth they want.
