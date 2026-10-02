# LyraShield AI for Auggie — preparation

This is an Auggie CLI native plugin marketplace package. It uses the documented `.augment-plugin`
manifest and command/skill directories, with a plugin-local `.mcp.json` for the hosted Streamable
HTTP endpoint. The five workflow skills are copies of the canonical sources at
`packages/agent-plugin/plugin/skills/`; `node docs/marketplace/augment/validate.mjs` checks that
they stay byte-identical in the source checkout before export. Maintainer validators are omitted
from the public marketplace export.

The manifests' `0.1.0` values are local preparation metadata, not released plugin versions. Bind the
exact reviewed artifact version and source commit when preparing a release.

## Maintainer staging review only

The following local package commands are for maintainer review of unpublished preparation
artifacts only. They are not current customer install recommendations. Do not use the mutable
marketplace default branch as an install source. Customer plugin instructions require a reviewed
matching immutable release; use the current client-specific direct MCP guide meanwhile.

Use Auggie's documented local plugin development flag from the product repository:

```sh
auggie --plugin-dir ./docs/marketplace/augment/plugins/lyrashield
```

A future customer marketplace recipe must bind an exact reviewed immutable artifact and matching
package release. No such install source is supplied by this preparation guide.

## Authentication boundary

Auggie's current integration documentation confirms remote HTTP MCP configuration and headers, but
does not document OAuth discovery or browser authentication for MCP servers. This package embeds no
credential. The hosted LyraShield endpoint requires authenticated access, so a configured URL is
not evidence that Auggie can connect. Treat hosted MCP runtime support as **PREPARATION** until an
authenticated Auggie client completes OAuth, selects a workspace, lists tools, and makes a read-only
call. If Auggie cannot complete that flow, the local stdio alternative requires Node.js 24 or newer
and an authenticated LyraShield CLI credential store; keep those credentials outside plugin files.

No hooks or automatic scans are installed. The scan command starts work only after explicit user
intent and an authorized target/profile are available. Read-only use is the default authorization
path; mutation still requires the LyraShield connection and workspace authorization to permit it.

## Distribution state

**PREPARATION** — Auggie supports user-hosted Git marketplaces. This package has not been installed
in a current Auggie runtime, submitted to a curated catalog, or read back from a public listing.
Marketplace availability and authenticated runtime support remain unverified.

Official references checked 2026-10-01:

- [Auggie plugins and marketplaces](https://docs.augmentcode.com/cli/plugins)
- [Auggie integrations and MCP](https://docs.augmentcode.com/cli/integrations)
