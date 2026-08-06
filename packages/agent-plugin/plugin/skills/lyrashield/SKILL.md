---
name: lyrashield
description: Run LyraShield security scans, review findings, and drive the fix → verify loop.
---

## Pre-PR check

1. Run check_diff on the staged changes to identify security issues introduced by this work item.
2. Review any findings before committing.
3. If findings are reported, address them or document why each is acceptable.
## Post-fix verification

1. After applying a fix for a security finding, run verify_fix with the finding ID.
2. Include the verification receipt in the PR description.
## Scope limits

- Only run security checks against targets that are owned by this workspace and explicitly listed as authorized targets in the LyraShield settings.
- Do not run checks on files or URLs you do not have permission to scan.
- Do not run scans against third-party URLs or repositories without explicit authorization.
## Honesty clause

A clean check result does not guarantee the absence of all vulnerabilities. A passing check is not a guarantee of zero vulnerabilities.
