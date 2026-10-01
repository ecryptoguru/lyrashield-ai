# LyraShield AI for Replit Agent — preparation

**State: PREPARATION.** The bundle contains a prefilled Replit custom-MCP install link and five Agent Skills. The link contains only the display name and hosted MCP URL; Replit should complete OAuth during the connection flow. No Replit client-runtime receipt or curated MCP catalog listing is confirmed.

## Connect hosted MCP

Use [`install-link.txt`](./install-link.txt) after this release candidate has been reviewed, or open Replit's Integrations pane and add a custom MCP server manually with the URL in [`connection.json`](./connection.json). Select **Test & save**, complete the OAuth flow, and choose the intended LyraShield workspace. The link contains no static credential header. Leave Replit's tool confirmation behavior enabled and verify one read-only workspace/target lookup before claiming successful setup.

The connection makes LyraShield's MCP tools available to Replit Agent across projects. Hosted OAuth defaults to read access. Any write requires a separately authorized delegation, current workspace permissions, and the relevant workflow authorization. Replit's security scanner may inspect or block MCP tools; such a client-side block is not proof that LyraShield accepted the operation.

## Install skills

The project-level skills in [`skills/`](./skills/) follow the Agent Skills format. Copy each skill folder to `/.agents/skills/<skill-name>/` in the Replit project to version it with the project. Replit also offers workspace-level skills from Workspace Settings; those require the applicable owner/admin permission and apply at broader scope. Replit documents importing community skills with its `npx skills` flow, but these source URLs become available only after the product source is merged to the public repository. Review each skill before enabling it.

## Compatibility evidence and limitations

- Official Replit MCP and skills docs checked 2026-10-01.
- The hosted URL and OAuth installation flow are documented by Replit; LyraShield has not completed the authenticated Replit runtime test.
- The link is a custom-MCP install link, not proof of a Replit marketplace listing. Replit's curated MCP catalog remains unverified for LyraShield.
- No local stdio path is bundled; this avoids relying on shell/runtime access in hosted Replit Agent.
- No workspace skill was imported and no public listing/submission was made.

Sources: [Replit Connect via MCP](https://docs.replit.com/build/connect-via-mcp), [Replit MCP catalog and custom-server install links](https://docs.replit.com/features/mcp/overview), and [Replit Agent Skills](https://docs.replit.com/features/agent/skills).
