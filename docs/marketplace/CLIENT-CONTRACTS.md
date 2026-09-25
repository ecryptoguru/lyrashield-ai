# Client configuration receipts

Checked 2026-09-25. These are documentation and local contract receipts, not authenticated client acceptance.

- Public npm metadata reports `@lyrashield/mcp@0.2.9` published. Its packed tarball matched the registry SHA-512 receipt, contained the stdio entrypoint, and answered MCP initialization plus `tools/list` with 15 tools using a synthetic credential and local-only API URL. Release validation repeats these checks. Deliberate release updates must update generator, registry, templates, validator and snapshots together.
- [Kiro configuration](https://kiro.dev/docs/mcp/configuration/) specifies `.kiro/settings/mcp.json` for workspaces and `~/.kiro/settings/mcp.json` for users. Merge the exported stdio entry into one of these files; do not assume the staged plugin directory is discovered.
- [Gemini extension configuration](https://geminicli.com/docs/extensions/reference/) documents environment filtering and `${extensionPath}`. The optional `GEMINI_LYRASHIELD_CRED` setting passes through a Node preload using [npx's Node options](https://docs.npmjs.com/cli/v11/using-npm/config#node-options). The preload removes empty credentials and inherited OAuth overrides while preserving `LYRASHIELD_API_URL`. Zed embeds the same normalization. Stored OAuth refreshes against its stored issuer; an explicit extension API key uses only the canonical Cloud HTTPS origin.
- [Kilo configuration](https://kilo.ai/docs/automate/mcp/using-in-kilo-code) documents `mcp` entries with `type: local`, a command array and `environment`. The marketplace template uses `{env:LYRASHIELD_API_KEY}` instead of embedding a key.
- [Cursor plugin reference](https://prod.cursor.com/docs/reference/plugins) documents HTTP MCP URLs. Its [first-party install payload](https://cursor.com/install-mcp?config=eyJ0eXBlIjoiaHR0cCIsInVybCI6Imh0dHBzOi8vbWNwLmF0bGFzc2lhbi5jb20vdjEvbWNwIn0%3D&name=atlassian) uses `type: http`.
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) documents a direct server map or a wrapped `mcp_servers` map for the bundled MCP manifest. The Codex shim points to `.mcp.codex.json`, which uses the direct-map form and leaves authentication to hosted OAuth.

Local checks cover generated configuration, exact package/version parity, secret exclusion, authorization wording and unset/empty/explicit extension credentials with inherited URL overrides. Still required: real installs of every claimed client reaching `lyrashield_list_workspaces` and forced-expiry OAuth sessions. These local receipts do not establish hosted or production acceptance.

## Distribution capability matrix

Verified 2026-09-26 against `pnpm pack` tarballs with `scripts/verify-agent-distribution.mjs --smoke` (all three receipts PASS). npm columns record `npm view` output observed 2026-09-26 — **refresh them at release time**; they lag the implementation versions while a release is in flight. Support-tier words follow the agent registry (`NATIVE`/`VERIFIED` require CLIENT_RUNTIME evidence these receipts are not; `COMPATIBLE`/`EXPERIMENTAL` entries carry documentation or package-conformance evidence). Evidence type "package-conformance + local receipt" means the packed artifact's manifest, files, secrets scan and local execution checks passed in this repository. These are package/config receipts, **not** live client acceptance.

| Package | Implementation | npm latest (obs.) | Transport | Support tier wording | Evidence | Verified |
| ------- | -------------- | ----------------- | --------- | -------------------- | -------- | -------- |
| `lyrashield` | 0.2.12 | 0.2.11 | cli | Installer/driver for every registry tier | package-conformance + local receipt | 2026-09-26 |
| `@lyrashield/mcp` | 0.2.9 | 0.2.9 | stdio (hosted remote-http is app-served) | COMPATIBLE stdio/config clients; EXPERIMENTAL clients pending client-runtime | package-conformance + local receipt | 2026-09-26 |
| `@lyrashield/agent-plugin` | 0.1.29 | 0.1.27 | remote-http `mcp.json` + client shims | Preferred for plugin-capable COMPATIBLE clients; Copilot stays EXPERIMENTAL | package-conformance + local receipt | 2026-09-26 |

Receipt detail kept locally (not committed): per-package sha256, file counts, bin inventory, the 15-tool `initialize` + `tools/list` result for `@lyrashield/mcp`, and CLI `--version`/`--help` exit-0 checks.

## npm release procedure (maintainer-authorized)

There is **no** dedicated npm-publish GitHub workflow (verified `.github/workflows` 2026-09-26: `ci.yml`, `deploy-azure.yml`, `release-production.yml`, `release-tauri.yml`, etc. — none publish npm). Publication is a manual maintainer step; never store npm tokens in the repository.

Dependency order for a coordinated bump: **`@lyrashield/agent-plugin` → `lyrashield` → `@lyrashield/mcp`**. The CLI's packed manifest depends on the plugin through a resolved `^x.y.z` range (pnpm rewrites `workspace:^` at pack/publish time), so the plugin version must exist on npm before `npm install lyrashield` can resolve. `@lyrashield/mcp` depends on neither package — publish it in the same wave because client docs pin its exact version.

Per package (dir `packages/<dir>` / name `<name>`: `agent-plugin`/`@lyrashield/agent-plugin`, `cli`/`lyrashield`, `mcp`/`@lyrashield/mcp`):

1. Bump `version` and any pinned references (`packages/agent-plugin` also needs `build:plugin` output regenerated).
2. `pnpm --filter @lyrashield/agent-plugin build:plugin` (once, for shims — it requires `@lyrashield/mcp` built first), then `pnpm --filter <name>... build`. `prepublishOnly` re-runs `tsup` at publish time; the explicit build keeps the packed artifact reviewed.
3. Pack and receipt **before** publishing:

   ```sh
   cd packages/<dir> && pnpm pack --pack-destination /tmp/lyrashield-release
   node scripts/verify-agent-distribution.mjs \
     --tarball /tmp/lyrashield-release/<a>.tgz [--tarball <b>.tgz] \
     --smoke --repo <repo-root>
   ```

   Every receipt must print PASS. The verifier fails closed on unresolved `workspace:`/`link:`/`file:` ranges, missing `publishConfig.access` on scoped packages, forbidden content (`.env`, `credentials.json`, `node_modules`, private `apps/web`/`packages/db` sources, private-key/`lsk_` material) and missing `files`/`bin`/`main`/README targets. With `--smoke` it additionally runs the packed CLI `--version`/`--help` and performs a real stdio `initialize` + `tools/list` against the packed MCP server using a synthetic credential and an unroutable API URL. Smoke dependency resolution links workspace/node_modules copies offline; `npm install` inside an unpacked tarball is expected to fail because pnpm resolves `workspace:*` devDependency entries to local-only versions — consumers never install devDependencies, so this does not block publication.
4. Publish manually: `cd packages/<dir> && pnpm publish` (`publishConfig.access: "public"` is already set in each manifest; pnpm resolves the workspace protocols and runs `prepublishOnly`). An npm account with publish rights and 2FA is required; pass `--otp <code>` when prompted.
5. **After** publish, verify from a fresh project, not this repo:

   ```sh
   npm view <name> version          # shows the just-published version
   npm install <name>@latest        # in an empty scratch directory
   node docs/marketplace/scripts/verify-published-mcp.mjs   # @lyrashield/mcp registry + stdio receipt
   ```

   Then update the npm column above and re-export `docs/marketplace` so pinned versions match what users can install.
