---
name: lyrashield
description: Run LyraShield security scans, review findings, and drive the fix → verify loop.
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

Fixes are proposals that require human review and approval; nothing is applied automatically.

Deeper modes consume more compute and take longer. Choose the least intensive goal and mode that answer the user's request.

| User intent | Goal | Mode | When to use |
| --- | --- | --- | --- |
| "Check this diff before I commit" / "Pre-PR check" | CHECK_PR | QUICK | Fast, bounded release review. Use STANDARD only if the user asks for a thorough pre-PR review. |
| "Quick check" / "Is this file safe?" | TEST_APP | QUICK | Fastest bounded repository scan. |
| "Review this repo" / "Standard security review" | TEST_APP | STANDARD | General code review. This is the default for general review. |
| "Launch review" / "Ready to ship?" | LAUNCH_REVIEW | STANDARD | Launch gating. |
| "Repository pentest" / "Deep security review" | FULL_PENTEST | DEEP | Intrusive agentic testing inside the authorized isolated repository sandbox. Never reinterpret this as permission to attack a live URL or API. |
| "Compliance review" | COMPLIANCE_REVIEW | DEEP | Compliance / audit use case. |
| "Weekly monitor" / "Re-check this" | WEEKLY_MONITOR | QUICK | Recurring lightweight check. |

If the user does not specify a mode, default to QUICK for pre-PR checks and STANDARD for general reviews. Only use DEEP when the user asks for a deep or compliance review.

## Example prompts and tool calls

Use these as a guide for common user requests:

- "Check this diff before I commit" → Run `lyrashield_check_diff` on the diff. If it reports issues, or the user asks for a full recorded scan, run `lyrashield_run_pr_scan` with goal `CHECK_PR` and mode `QUICK`.
- "Scan this repo" / "Review this project" → Resolve the current/default target, then run `lyrashield_scan_target` with goal `TEST_APP` and mode `STANDARD`.
- "Run a launch review" → Run `lyrashield_scan_target` with goal `LAUNCH_REVIEW` and mode `STANDARD`.
- "Repository pentest" / "Deep security review" → For an authorized repository target, run `lyrashield_scan_target` with goal `FULL_PENTEST` and mode `DEEP`. For URL/API targets, explain that Deep is non-mutating behavioral review, not live exploit testing.
- "Explain finding f-123" → Run `lyrashield_explain_finding` with the finding ID.
- "How do I fix this?" → Run `lyrashield_generate_fix_plan` with the finding ID.
- "I applied the fix" → Run `lyrashield_verify_fix` with the finding ID, poll the returned retest scan to a terminal state, and include its outcome and scan reference in the PR. Call it independently verified only when a separate independent-verification receipt exists.
- "Summarize security for this PR" → Run `lyrashield_create_pr_security_recap`.

## Depth and runtime awareness

Deeper modes consume more compute and take longer. Choose the least intensive mode that answers the user's question. Do not run DEEP scans for quick checks, and avoid re-running the same scan repeatedly. When in doubt, ask the user which depth they want.
