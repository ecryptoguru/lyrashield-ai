# LyraShield Review for Codebuff

Canonical source: the [LyraShield marketplace repository](https://github.com/ecryptoguru/lyrashield-marketplace/tree/main/codebuff).
Replace the local `types/agent-definition` import with the generated Codebuff types, then
publish version `0.1.2` as `lyrashield/lyrashield-review`. The agent is intentionally read-only:
mutating requests surface a `connect_required` response directing the client to connect over OAuth
and no approval is created.
