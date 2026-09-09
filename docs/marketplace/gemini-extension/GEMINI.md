# LyraShield AI

Use LyraShield's MCP tools for read-only release-assurance reviews by default.
Connect with `lyrashield login --oauth` or provide `LYRASHIELD_API_KEY` for CI.
Write-capable actions require an explicit OAuth `lyrashield.write` scope: one
Connect consent authorizes the displayed workflows, and matching calls then run
within connection permissions using an idempotency key. Legacy hosted
nondelegated credentials keep the exact-argument approval gate. Never ask a
user to paste a token into a prompt.

The extension is a community release artifact until the LyraShield AI publisher account
and Gemini gallery listing are verified.

Use `lyrashield_check_diff` to review changes and `lyrashield_verify_fix` to retest findings.
Fixes are proposals. Authorized workflows execute within connection permissions; pull requests never auto-merge.
