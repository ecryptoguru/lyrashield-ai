# LyraShield AI

Use LyraShield's MCP tools for read-only release-assurance reviews by default.
Connect with `lyrashield login --oauth` or provide `LYRASHIELD_API_KEY` for CI.
Write-capable actions require an explicit OAuth `lyrashield.write` scope: one
Connect consent authorizes the displayed workflows and matching calls then run
within connection permissions using an idempotency key. Nondelegated hosted
writes receive `connect_required`; local stdio instead uses credential-scoped REST authorization without a second approval prompt. Never ask a
user to paste a token into a prompt.

The extension is a community release artifact until the LyraShield AI publisher account
and Gemini gallery listing are verified.

Use `lyrashield_check_diff` to review changes and `lyrashield_verify_fix` to retest findings.
Fixes are proposals. Authorized workflows execute within connection permissions; pull requests never auto-merge.

The user-invoked `/lyrashield:review-changes` command is a local, read-only advisory check of
tracked staged and unstaged changes; it never starts a recorded scan. Only `/lyrashield:scan-project`
starts a recorded PR scan, and only after the user has selected an authorized workspace and target.
State the selected depth and possible plan-allowance or agent-minute use. Keep the returned scan ID
for status checks, and preserve incomplete or inconclusive evidence states.
