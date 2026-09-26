# Agent package distribution receipt

The packages and marketplace files have separate release states. A source build or a client configuration file does not prove an npm release, a deployed hosted MCP server, or a working client session.

## Capability and release matrix (2026-09-26)

| Surface                    | Source version at `0f87d24b` | npm `latest` | Transport                                | Support evidence                                                                                                | Client/runtime evidence                                                 |
| -------------------------- | ---------------------------- | ------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `lyrashield` CLI           | `0.2.12`                     | `0.2.11`     | Terminal and REST API                    | Local packed executable: version, help, installer dry-run, JSON connections and quality against a synthetic API | Node `24.17.0` only; live account and CI client not checked             |
| `@lyrashield/mcp`          | `0.2.9`                      | `0.2.9`      | stdio; hosted Streamable HTTP separately | Local packed stdio: initialize and 15-tool catalog                                                              | Native editor clients and hosted deployment not checked in this receipt |
| `@lyrashield/agent-plugin` | `0.1.29`                     | `0.1.27`     | Client-specific plugin/marketplace files | Local packed manifest and expected plugin files; CLI dependency resolves to `^0.1.29`                           | Marketplace installation and client activation not checked              |

The npm versions are a read-only registry observation on 2026-09-26. Refresh dist-tags before publication. The source SHA describes the checked-out baseline; the smoke run also included uncommitted work, so these tarballs are **not** immutable release artifacts.

The six-workstream release candidate now stages `lyrashield@0.2.13`, `@lyrashield/mcp@0.2.10`, and `@lyrashield/agent-plugin@0.1.30`. These versions are unpublished. Client pins in this repository refer to the staged MCP package and must not be exported publicly before its npm release.

Run `pnpm --filter @lyrashield/agent-plugin... --filter lyrashield... --filter @lyrashield/mcp... build`, then `pnpm pack --pack-destination <temporary-directory>` in each package directory. Verify the three archives with:

```sh
node scripts/verify-agent-distribution.mjs \
  --cli <temporary-directory>/lyrashield-<version>.tgz \
  --mcp <temporary-directory>/lyrashield-mcp-<version>.tgz \
  --plugin <temporary-directory>/lyrashield-agent-plugin-<version>.tgz
```

The verifier reads packed manifests, rejects unresolved local dependency ranges and forbidden files, checks required runtime files and SHA-256 hashes, installs into a disposable home, calls CLI JSON commands against a synthetic server, and negotiates a real stdio MCP session. It does not publish packages, contact a live LyraShield API, or install into a real agent configuration. The retained JSON receipt lists exact archive checksums and tool names. Repeat on final committed SHA, then separately verify exact npm releases, default dist-tags, hosted deployment, and real clients.
