---
name: scan-project
description: "Use when the user asks to start an explicitly requested scan on an authorized LyraShield target."
---

# Scan a project

Start a recorded scan only when the user asks for one.

1. Resolve the selected `workspaceId` and an authorized `targetId` using `lyrashield_list_workspaces` and `lyrashield_list_targets` when needed.
2. Call `lyrashield_get_scan_eligibility` as a read-only advisory preflight. A pass does not guarantee that scan creation will be admitted; the server checks again.
3. Use the least intensive requested profile: QUICK for an ordinary pre-PR check, STANDARD for a general review and DEEP only when the user explicitly requests it and the selected target/profile permits it. Set the intended goal and mode explicitly.
4. Call `lyrashield_scan_target` or the PR-specific `lyrashield_run_pr_scan` using only fields in the current tool schema. Create and retain one unique `idempotencyKey` for this intended action and reuse it for identical retries. Use a new key only for a separately requested scan.
5. Save the returned `scanId` or `operationId`. Poll `lyrashield_get_scan_status` with exactly one identifier, starting after 2 seconds and doubling the delay up to 30 seconds. Stop at a terminal state or after 20 checks. If the session or polling limit ends first, return the resumable identifier and resume it later instead of starting a replacement scan.

Never scan a guessed, third-party or unapproved target. Report failed, cancelled, inconclusive and insufficient-evidence outcomes explicitly.
