---
name: lyrashield
description: Review LyraShield release-assurance evidence through an OAuth-first MCP connection.
version: 0.1.28
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
issues and explain connection requirements. Prefer read-only tools. Do not claim that a result is a
security guarantee or that all Vibe Security 50 controls were verified.

The skill is a community ClawHub listing. It is not an official OpenClaw channel. Link to
LyraShield dashboard evidence instead of
recreating dashboard UI or copying report contents into prompts.

Write actions require OAuth `lyrashield.write`. New delegated connections authorize
their workflows once through the Connect consent and then execute within connection
permissions using an idempotency key. Nondelegated hosted writes receive
`connect_required`; local stdio approval is separate. An API key is optional for read-only or CI use.

Use `lyrashield_check_diff` to review changes and `lyrashield_verify_fix` to retest findings.
Fixes are proposals. Authorized workflows execute within connection permissions; pull requests never auto-merge.
