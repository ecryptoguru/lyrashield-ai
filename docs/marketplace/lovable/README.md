# LyraShield AI for Lovable — preparation

**State: PREPARATION.** The bundle includes five workspace skills in Lovable's documented `SKILL.md` shape, single-skill ZIP imports and future GitHub subdirectory URLs. The hosted MCP connector is configured manually in Lovable; `connection-details.json` is reference data, not a v0-style client config file. No Lovable runtime acceptance or connector-catalog listing is confirmed.

## Add the skills

Workspace owners/admins can import a public GitHub subdirectory or upload a ZIP under **Workspace settings → Skills → Add**. [`imports/`](./imports/) contains one `.zip` for each skill, with `SKILL.md` at the archive root. [`github-import-urls.txt`](./github-import-urls.txt) lists the source URLs to use after this product source is merged to the public `main` branch; they are not available from the current unmerged checkout. Import a single skill through its ZIP before using the source links from a public clone.

Skill changes and imports are workspace-wide; review the content first and select whether automatic use should be enabled. Scan and retest skills require an explicit request and authorized target. Lovable may apply a matching skill automatically, but that instruction does not authorize a LyraShield scan by itself.

## Connect MCP for project chat

Open Lovable's Connectors catalog, choose **+ → MCP server**, name it LyraShield AI, use `https://app.lyrashieldai.com/api/mcp` and keep the default **OAuth** method. Complete sign-in and choose the intended LyraShield workspace. Do not place an API key, OAuth token or bearer header in a generated app or a shared file. A workspace admin can disable custom MCP servers; an MCP connection is personal to the user who connected it.

Lovable treats this as a **chat connector**: it supplies tools and context while you build in project chat/Chats. It is not included in the published application and generated app code cannot call this chat connection. If the generated app itself must call LyraShield, that requires a separately designed app/API integration; do not reuse the authoring connector's credentials.

## Files and compatibility boundary

- [`skills/`](./skills/) contains the editable source `SKILL.md` files.
- [`imports/`](./imports/) contains the upload-ready skill ZIPs.
- [`github-import-urls.txt`](./github-import-urls.txt) contains post-merge GitHub import URLs.
- No Marketplace submission, skills-directory indexing, authenticated connector call or runtime receipt has been completed.

Official docs checked 2026-10-01: [Lovable custom MCP chat connectors](https://docs.lovable.dev/integrations/custom-mcp) and [workspace skills and GitHub/ZIP imports](https://docs.lovable.dev/features/skills).
