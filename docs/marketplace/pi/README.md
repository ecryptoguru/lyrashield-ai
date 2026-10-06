# LyraShield in Pi core

**State: PREPARATION.** The canonical LyraShield workflow skills are prepared for Pi's native package
loader through the conventional root-level `skills/` directory in the generated
`lyrashield-marketplace` repository. Install from that Git root only after an immutable release tag
contains the reviewed export. No Pi catalog listing or authenticated Pi runtime acceptance has been
verified.

Pi packages can be installed from Git and can expose conventional `skills/` directories without a
Pi-specific executable extension. The package root remains the shared marketplace root; this folder
contains only Pi-specific instructions, a secret-free MCP example and an offline validator. The
five focused workflow skills are `get-started`, `review-changes`, `scan-project`, `fix-and-retest`,
and `launch-readiness`. The generated root also retains the legacy `lyrashield` skill for backward
compatibility.

## Install from the marketplace Git root

Once a reviewed marketplace release is published, pin Pi to its immutable release tag:

```sh
pi install git:github.com/ecryptoguru/lyrashield-marketplace@<released-tag>
pi list
```

Pi stores personal package declarations in `~/.pi/agent/settings.json`. To add the package to a
project instead, use the same source with `--local`:

```sh
pi install --local git:github.com/ecryptoguru/lyrashield-marketplace@<released-tag>
```

That declaration is written to `.pi/settings.json` and is loaded only after project trust is granted.
Review the release and every skill before trusting the project. `pi list` shows configured packages;
it does not prove an MCP connection, authenticated tool call or scan. A project declaration with
the same Git package identity normally replaces the personal package entry.

The current source checkout is not itself the exported package root, and the release tag placeholder
above must be replaced with a published immutable tag. Do not install from an unreviewed default
branch or claim Pi package-catalog availability. Pi's package gallery discovery applies to npm
packages; this preparation does not create or publish a new npm package.

## Configure Pi's built-in MCP client

The skill package and MCP connection are separate. Pi's built-in client connects over stdio or
Streamable HTTP and handles OAuth for a remote server when no static Authorization header is set.
For hosted access, the recommended command is:

```sh
pi mcp add lyrashield --url https://app.lyrashieldai.com/api/mcp
pi mcp list
pi mcp login lyrashield
```

Pi stores hosted OAuth tokens in its user credential store at
`~/.pi/agent/mcp-auth.json`. Do not put credentials in MCP configuration or share personal
connections in a project file. An equivalent secret-free server entry is provided in
[mcp.json](./mcp.json); add only that entry to an existing configuration rather than replacing
unrelated servers. The sample is not installed automatically by the package.

Pi reads user-level MCP servers from `~/.pi/agent/mcp.json`. It reads project servers from
`.pi/mcp.json` only after project trust is granted, and a project entry with the same name replaces
the user entry. Keep credential-bearing connections at user scope. If the connection needs sign-in,
complete the browser flow with `pi mcp login lyrashield`, then make a read-only LyraShield call such
as workspace discovery. Setup and discovery alone are not an authenticated runtime receipt. Do not
start a paid scan unless the user explicitly requests it and the workspace, target and profile are
authorized.

Local stdio uses the published CLI `0.2.14` and MCP `0.2.12`, which include the explicit idempotency
fields required by the focused workflows. The matching immutable marketplace skill release remains
pending. Do not pair the new workflow skills with the older published MCP `0.2.11`:

```sh
npx -y lyrashield@0.2.14 login --oauth
pi mcp add lyrashield-stdio -- npx -y @lyrashield/mcp@0.2.12
pi mcp list
```

The local server uses the LyraShield CLI credential store and requires Node.js 24 or newer. Its
credentials are separate from Pi's hosted OAuth credentials. Do not substitute a workspace API key
for hosted OAuth delegation.

## Validate this preparation

From the product repository root, run:

```sh
node docs/marketplace/pi/validate.mjs
```

The offline maintainer validator runs from the LyraShield AI source checkout before export. It checks
the secret-free Pi MCP example, package/trust instructions and the presence of the five canonical
source skills. Maintainer validators are omitted from the public marketplace export. This check does
not establish Pi runtime or catalog acceptance.

## Official references

- [Pi Packages](https://pi.dev/docs/latest/packages) — Git and npm package sources, conventional
  resource directories, project trust and package identity.
- [Pi Skills](https://pi.dev/docs/latest/skills) — Agent Skills discovery and trust guidance.
- [Pi MCP](https://pi.dev/docs/latest/mcp) — built-in MCP configuration, OAuth and project trust.
