# LyraShield AI

Use LyraShield's MCP tools for read-only release-assurance reviews by default.
Connect with `lyrashield login --oauth` or provide `LYRASHIELD_API_KEY` for CI.
Write-capable actions require an explicit OAuth `lyrashield.write` scope and the
existing exact-argument approval gate; never ask a user to paste a token into a prompt.

The extension is a community release artifact until the LyraShield AI publisher account
and Gemini gallery listing are verified.

Use `lyrashield_check_diff` to review changes and `lyrashield_verify_fix` to retest findings.
Fixes are proposals that require human review and approval; nothing is applied automatically.
