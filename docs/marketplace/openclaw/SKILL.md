---
name: openclaw
description: Review LyraShield release-assurance evidence through an OAuth-first MCP connection.
---

# LyraShield AI review skill

Use the LyraShield MCP connection to inspect release-assurance evidence, summarize current
issues, and explain pending approvals. Prefer read-only tools. Do not claim that a result is a
security guarantee or that all Vibe Security 50 controls were verified.

The skill is a community ClawHub listing. It is not an official OpenClaw channel. Link to
LyraShield dashboard evidence instead of
recreating dashboard UI or copying report contents into prompts.

Write actions require OAuth `lyrashield.write` plus the exact-argument approval gate.
