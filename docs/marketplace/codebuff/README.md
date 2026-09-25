# LyraShield Review for Codebuff

Canonical source: the [LyraShield marketplace repository](https://github.com/ecryptoguru/lyrashield-marketplace/tree/main/codebuff).
Replace the local `types/agent-definition` import with the generated Codebuff types, then
publish the version declared in `lyrashield-review.ts` as `lyrashield/lyrashield-review`.
The agent exposes only read-only LyraShield MCP tools. Its local stdio server still checks the
credential's REST permissions on every request; hosted OAuth delegation is a separate connection
path. Supply the diff to the agent when its read tools cannot access it.

Use Node.js 24. For stored OAuth, run `npx -y lyrashield@0.2.11 login --oauth`, select a
workspace, then restart Codebuff. Confirm `lyrashield_list_workspaces` and an authorized target
read before reviewing a change. If authorization expires, repeat CLI login. Removing this agent
does not revoke a credential shared with other local clients; revoke it in account settings when
required.
