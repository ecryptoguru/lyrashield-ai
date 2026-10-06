---
name: lyrashield
description: Review LyraShield release-assurance evidence through an OAuth-first MCP connection.
version: 0.1.31
license: MIT-0
metadata:
  category: security
  author: LyraShield AI
  source:
    repository: https://github.com/ecryptoguru/lyrashield-marketplace
    path: openclaw
    license_path: openclaw/LICENSE
  openclaw:
    requires:
      env: []
---

# LyraShield AI review skill

Use the LyraShield MCP connection to inspect release-assurance evidence, summarize current
issues and explain connection requirements. Prefer read-only tools. Do not claim a security
guarantee, universal detection or compliance. Preserve coverage limits and evidence states.

The skill is a community ClawHub listing. It is not an official OpenClaw channel. Link to
LyraShield dashboard evidence instead of
recreating dashboard UI or copying report contents into prompts.

Write actions require OAuth `lyrashield.write`. New delegated connections authorize
their workflows once through the Connect consent and then execute within connection
permissions using an idempotency key. Nondelegated hosted writes receive
`connect_required`; local stdio instead uses credential-scoped REST authorization without a second approval prompt. An API key is optional for read-only or CI use.

Use `lyrashield_check_diff` for a read-only advisory review; its result is not a recorded scan.
Call `lyrashield_verify_fix` only after the user confirms a fix was applied. Create one unique
idempotency key for each intended mutation and reuse it only for an identical retry. Retain the
returned retest scan reference; poll `lyrashield_get_scan_status` with the workspace and exactly
one `scanId` or `operationId`, using bounded backoff. If the session ends before a terminal status,
return the reference so the same retest can resume. Fixes remain proposals until trusted retest
evidence establishes the outcome. Authorized workflows execute within connection permissions;
pull requests never auto-merge.
