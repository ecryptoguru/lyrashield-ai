# LyraShield AI for Qwen Code — preparation

This is a Qwen-native extension using the documented `qwen-extension.json`, `commands/`, `skills/`,
`QWEN.md`, and HTTP MCP server configuration. The five workflow skills are copied from the
canonical files in `packages/agent-plugin/plugin/skills/`. The source-checkout maintainer validator
checks manifest structure, read-only OAuth scope and byte-for-byte skill parity before export; it
is not included in the public marketplace export.

The extension's `0.1.0` value is preparation metadata, not a published release identity. Bind the
exact reviewed artifact version and source commit when preparing a release.

## Local discovery

From the product repository, link the extension directory for local development:

```sh
cd docs/marketplace/qwen
qwen extensions link .
```

Restart Qwen Code, then check `/skills`, `/mcp`, and the available commands. Qwen documents direct
installation from a Git repository, GitHub release archive or npm package. The released artifact
must place this extension directory's contents at its root; a repository containing this nested
source folder is not itself an installable extension root.

## Authentication and scope

The extension config uses the documented `httpUrl` field and OAuth configuration, requesting only
`lyrashield.read`. Qwen Code's OAuth token file defaults to mode `0600` but is plaintext; on shared
or multi-user machines set `QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE=true` before authenticating. Verify
the connected user and workspace with a read-only call. Scan, fix-proposal and retest tools require
explicit user intent plus appropriate LyraShield workspace permissions and delegated authorization.
The server's connection grant remains authoritative. `trust` is omitted, so the extension does not
disable Qwen's tool confirmations.

## Distribution state

**PREPARATION** — Qwen Code documents direct Git, GitHub Releases and npm extension distribution; a
separate curated public extensions marketplace or submission intake was not found in the current
official documentation. No release or authenticated Qwen runtime acceptance has occurred, and no
public listing is claimed.

Official references checked 2026-10-01:

- [Qwen Code extension format](https://qwenlm.github.io/qwen-code-docs/en/users/extension/introduction/)
- [Qwen Code MCP and OAuth](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/)
- [Qwen Code extension release routes](https://qwenlm.github.io/qwen-code-docs/en/users/extension/extension-releasing/)
