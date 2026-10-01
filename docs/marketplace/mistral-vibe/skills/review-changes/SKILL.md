---
user-invocable: true
name: review-changes
description: "Review the current diff with LyraShield's read-only advisory check."
---

# Review changes

Use this skill when the user asks for a review of staged or current code changes.

1. Read the requested diff from the working tree. Use `git diff --cached` for staged-only changes or `git diff HEAD` for the full working-tree change set.
2. Call `lyrashield_check_diff` with its required `diff` field. Add `files` only when full-file snapshots are available and fit the tool's current limits.
3. Describe results as advisory heuristics. Preserve the returned coverage state; an incomplete advisory check is not a recorded scan and does not establish that the code is secure.
4. Start a recorded Quick scan with `lyrashield_run_pr_scan` only when the user explicitly requests one, and only after resolving the authorized workspace and target. Do not start one because an advisory finding appeared.

If no diff is available, report that and ask for the intended files or range. Never invent diff content.
