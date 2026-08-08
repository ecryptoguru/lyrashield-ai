# LyraShield Review for Codebuff

Canonical source: [lyrashield-codebuff-agent](https://github.com/ecryptoguru/lyrashield-codebuff-agent).
Replace the local `types/agent-definition` import with the generated Codebuff types, then
publish it as `lyrashield/lyrashield-review`. The agent is intentionally read-only:
mutating requests explain the pending LyraShield approval and link to dashboard evidence.
