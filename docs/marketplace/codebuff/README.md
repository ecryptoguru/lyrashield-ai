# LyraShield Review for Codebuff

PREPARATION ONLY: the `0.1.31` agent artifact targets unpublished MCP `0.2.12` and CLI `0.2.14`
release candidates. Update the existing listing only after the coordinated npm release is reviewed.

Maintainer preparation source: `docs/marketplace/codebuff` in the product checkout. The mutable
marketplace default branch is not a customer install source.
Replace the local `types/agent-definition` import with the generated Codebuff types, then
publish the version declared in `lyrashield-review.ts` as `lyrashield/lyrashield-review`.
The agent exposes only read-only LyraShield MCP tools. Its local stdio server still checks the
credential's REST permissions on every request; hosted OAuth delegation is a separate connection
path. Supply the diff to the agent when its read tools cannot access it.

For maintainer acceptance after the coordinated release, use Node.js 24. For stored OAuth, run `npx -y lyrashield@0.2.14 login --oauth`, select a
workspace, then restart Codebuff. Confirm `lyrashield_list_workspaces` and an authorized target
read before reviewing a change. If authorization expires, repeat CLI login. Removing this agent
does not revoke a credential shared with other local clients; revoke it in account settings when
required.
