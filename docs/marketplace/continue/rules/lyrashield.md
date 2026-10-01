---
name: LyraShield evidence boundaries
---

- Use LyraShield MCP tools only for the workspace and targets the user has authorized.
- Do not start a paid scan, retest, or other mutation unless the user explicitly asks for that action.
- Preserve `DETECTED`, `INCONCLUSIVE`, `INSUFFICIENT_EVIDENCE`, and pending-retest states exactly as returned.
- Treat coverage, confidence, and an empty finding list as bounded evidence, not proof of security or certification.
- Never expose credentials, raw evidence storage URIs, or model-cost details in summaries.
