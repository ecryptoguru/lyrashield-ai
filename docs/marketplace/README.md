# LyraShield AI marketplace release source

PREPARATION ONLY: Agent Plugin `0.1.31`, MCP `0.2.12`, and CLI `0.2.14` are local
release candidates and have not been published. This marketplace export must not be installed
from a released listing until the coordinated npm and marketplace release is reviewed.
Channel-specific listing versions and review states may lag this source.

## Source and publication readback — 2026-10-02

The clean product source is `4822306e24f375800981bf282fd992a9c15dcde8`. Public marketplace `main` is commit `8cb880dbaee73f2c6e71d096e4b75db87f29c32a`, regenerated from that product revision; a fresh clean export matched its tracked artifact bytes. This branch readback is not an immutable marketplace release.

Current npm latest versions are CLI `0.2.13`, MCP `0.2.11`, and Agent Plugin `0.1.30`. Product-source candidates CLI `0.2.14`, MCP `0.2.12`, and Agent Plugin `0.1.31` each return npm `E404`. The latest immutable marketplace GitHub Release is `v0.1.29` (2026-09-25); its Kiro MCP shim pins `@lyrashield/mcp@0.2.9`. Tags/releases `v0.1.30` and `v0.1.31` do not exist. The current branch release workflow creates an immutable tag/release and verifies the generated MCP pin against npm, so the current `.2.12` candidate pin is not publishable until its coordinated packages have been released and read back.

The prepared official MCP Registry package has no public listing: an official registry search returned zero LyraShield entries on 2026-10-02, and release-ready ownership validation remains blocked on the unpublished MCP package. Package/export validation and public branch synchronization do not establish npm publication, immutable marketplace availability, authenticated client use, or client-runtime acceptance.

## Current customer setup

This mutable preparation branch is not a supported customer install source. Do not register it
with a plugin marketplace, import it into VS Code, enable it in shared settings, or use an older
plugin release without matching portable-schema validation. Plugin installation recommendations
for Claude Code, Cursor, Copilot CLI, Codex and VS Code await a reviewed matching immutable release.

Use the currently published pinned direct MCP server `@lyrashield/mcp@0.2.11` meanwhile. Local
stdio requires Node.js 24 or newer. Authenticate separately in the same OS account with
`npx -y lyrashield@0.2.13 login --oauth`, then merge the client-specific config while preserving
existing entries. Published CLI config writes and skill installation remain withheld until the
coordinated safe-writer release.

| Client       | Current direct MCP guide                                                   | Config contract                                             |
| ------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Cursor       | [Cursor guide](https://lyrashieldai.com/docs/integrations/cursor)          | `.cursor/mcp.json`, `mcpServers`, stdio                     |
| Claude Code  | [Claude guide](https://lyrashieldai.com/docs/integrations/claude-code)     | `.mcp.json`, `mcpServers`, stdio                            |
| Copilot CLI  | [Copilot guide](https://lyrashieldai.com/docs/integrations/github-copilot) | `~/.copilot/mcp-config.json`, `mcpServers`, `type: "local"` |
| OpenAI Codex | [Codex guide](https://lyrashieldai.com/docs/integrations/openai-codex)     | `~/.codex/config.toml`, `[mcp_servers.lyrashield]`          |
| VS Code      | [VS Code guide](https://lyrashieldai.com/docs/integrations/vscode)         | `.vscode/mcp.json`, `servers`, `type: "stdio"`              |

Restart the client, confirm server/tool discovery, then call `lyrashield_list_workspaces` and an
authorized target read. Discovery, OAuth authentication and successful service calls are distinct
checks. If consent expires, repeat CLI login and restart the client.

GitHub Copilot Cloud Agent is a separate read-only surface. Follow its
[prepared configuration guide](./github-copilot-cloud-agent/README.md) for the current
read-only API-key/MCP configuration and explicit tool allowlist. Skill-copy steps are withheld
until a matching reviewed immutable release exists; do not copy candidate skills from this branch. Its API key belongs in the private Agents
secret store; the portable plugin's OAuth descriptor cannot authenticate it.

## Maintainer preparation only

The staged `.claude-plugin/marketplace.json` catalogs the root candidate with `source: "./"`.
This packaging layout is for offline export and review. It is not an invitation to register the
mutable repository or a statement that any candidate is published. Bind a future install recipe
to the exact reviewed immutable artifact and matching npm release before adding customer steps.

## Release boundary

The installable client boundary is the exported root `plugin.json`, OAuth-first `mcp.json`,
`skills/` and generated client shims. It is Apache-2.0; the hosted dashboard, worker and engine
remain proprietary. The OpenClaw directory additionally carries its narrow MIT-0 grant.
The release job must export only these files to the dedicated public `lyrashield-marketplace`
repository:

- root `plugin.json`, `mcp.json`, `skills/`, client shims and client adapters
- native bundles for Gemini CLI, Kiro, Cline, Kilo, OpenClaw, Zed, Codebuff, Amp, OpenCode,
  Antigravity, Augment, Factory, Qoder, Qwen, Devin, JetBrains, Goose, Hermes, Pi Core and other
  documented client surfaces
- official MCP Registry `server.json` and its vendored schema/provenance
- marketplace icons, screenshots, changelog, support/privacy/terms links and test fixtures

The export must not contain `.env` files, credentials, database schema, customer data, hosted
service source or generated build caches. Run
`pnpm --filter @lyrashield/agent-plugin export:marketplace /path/to/export` to create the
deterministic release boundary. `manifest.json` records the source package, version, generated
files and forbidden hosted-service paths; the export test fails if an artifact disappears.

Before releasing this candidate, publish and verify MCP `0.2.12`, update every stdio runtime pin
from the currently published `0.2.11`, then regenerate, pack and verify the exact plugin and CLI
artifacts. The new recorded-scan and retest skills require the explicit `idempotencyKey` fields
in the new MCP tool schemas; do not release those workflows against an older stdio server.

The export includes native artifacts from each supported client wave. Listing applications remain
separate; the [channel ledger](./channels.md) records the verified intake route, package identity,
public state and remaining evidence for each one. The Gemini repository must additionally carry
the `gemini-cli-extension` topic.

## Submission order

1. Founder/counsel approval of `/privacy`, `/terms`, `/support` and the security-reporting mailbox.
2. Create and verify the LyraShield AI publisher identity and sanitized reviewer workspace.
3. Export and tag the public repository with an immutable version.
4. Smoke-test OAuth connect, workspace selection, read-only MCP calls, delegated idempotent writes,
   out-of-grant denial, legacy approval, pause, forced expiry, permission loss, refresh/reconnect,
   disconnect/revocation, CLI API-key fallback, Zed, Codebuff and the generated marketplace fixtures.
5. Submit the shared listing to OpenAI/Codex, Claude, Cursor, Kiro, Cline, Kilo, Zed, Codebuff,
   Gemini CLI and ClawHub according to each channel's current intake. Verify GitHub Copilot through
   its plugin marketplace path; Awesome Copilot is not a product-listing channel.

Marketplace availability is claimed only for channels with a visible public listing, never merely a
submitted application. Direct adapter guides remain available for clients without a verified
marketplace program.

## Submission tracking

Public channel states were last checked on 2026-10-01. Private publisher dashboards remain
`UNKNOWN` unless there is a current authenticated readback. See the [distribution channel ledger](./channels.md)
for the current public links, versions, evidence, and next step for each channel. Directory status
does not establish client compatibility.
