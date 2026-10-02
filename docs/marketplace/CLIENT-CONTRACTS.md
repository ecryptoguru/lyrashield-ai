# Client configuration receipts

Updated 2026-10-02. Historical package readbacks remain dated at the time they were collected;
current local native-client receipts are recorded below. They do not establish authenticated access
or public marketplace acceptance.

## Clean source distribution readback — 2026-10-02

From exact product source `4822306e24f375800981bf282fd992a9c15dcde8`, CLI `0.2.14`, MCP `0.2.12`, and Agent Plugin `0.1.31` built and packed into a fresh temporary directory. The offline `scripts/verify-agent-distribution.mjs --smoke --no-install --repo <exact-source>` check passed for all three packages:

| Package                           | Entries |     Bytes | SHA-256                                                            | Result                                                    |
| --------------------------------- | ------: | --------: | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `lyrashield@0.2.14`               |       6 | 1,280,490 | `1be4e4340db572b403dcbbb23ec72e91196a62e0b4b539bf173b277566e0e1db` | Offline dependency link, `--version`, and `--help` passed |
| `@lyrashield/mcp@0.2.12`          |      13 |   729,642 | `3e0ebcd9950317b37cc0604d0b5c4c84ddadcdd7a6ca4029621f98626e68581f` | MCP initialize and `tools/list` returned 21 tools         |
| `@lyrashield/agent-plugin@0.1.31` |      35 |   105,681 | `32c9f40b15f53ab4996cc55c86812afc06326871f4d21737bf9ff7c5ebbf0374` | Offline dependency link and package import passed         |

The source build passed 5/5 tasks; the focused suite passed 15 files / 392 tests. A clean candidate marketplace export passed release validation for 55 generated artifacts and 306 manifest file records. The public marketplace branch at `8cb880dbaee73f2c6e71d096e4b75db87f29c32a` matches that clean export byte-for-byte, but its latest immutable release remains `v0.1.29` and its released Kiro shim pins MCP `0.2.9`. The SHA-256 values above identify those source-built packages, not the later published npm tarballs.

At the time of that source-build readback, npm latest was CLI `0.2.13`, MCP `0.2.11`, and Agent Plugin `0.1.30`; lookups for `.14`, `.12`, and `.31` returned `E404`. The packages were subsequently published and verified as recorded below. The prior source build did not establish npm publication or authenticated client-runtime acceptance.

## Published npm readback — 2026-10-02

Public registry metadata reports these versions as `latest`; `next` also points to the same versions. Public tarballs were downloaded and their SHA-256 values matched the reviewed release receipts. Clean consumer installs passed with npm lifecycle scripts disabled.

| Package                    | Version  | Published tarball SHA-256                                          | Integrity                                                                                         |
| -------------------------- | -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `lyrashield`               | `0.2.14` | `430a66a4a61302d1143b6857f729e52a2178ae459f0036fda8ea0dc865ece14f` | `sha512-rHTecJqsFLrr260uL5+Wtmgi2zpxrmaZ6yuXX1PbNmtPJCx/PSZYLwBIV1+o7beH4gP/W+KNdwmGFcDShD0vlQ==` |
| `@lyrashield/mcp`          | `0.2.12` | `5eedb9e22d04e9df111f79cc0f5c70840d572f7617a671f8d232cb6317563988` | `sha512-sePbYF7n2YtP1kpgDmdyiMbdV5Sa0bollRaZtmiTH0NguDlbOuHu5Dl1bauVXFsNeveTKfXTDACkVjkdOTNK8A==` |
| `@lyrashield/agent-plugin` | `0.1.31` | `6f60077b65ef838bfdfee5cfe3bd0e38cc14e3bb51a4dee25f4033daf6c04d02` | `sha512-J88f0ceIf/BbDoNCuTY/1ARWrFFSvjMExRamMoiXA48tMyguEquegAuJuBYwGIslmaldoL52z3tgpgwOf32tyQ==` |

The published MCP package reports `mcpName: io.github.ecryptoguru/lyrashield-ai`. Vendored official-schema `--release-ready` validation and official `mcp-publisher validate` passed. No LyraShield entry has been published to the official Registry; authenticated publisher login and API readback remain pending.

## Safe native CLI runtime smoke — 2026-10-02

These checks used temporary user/config roots on macOS, the public MCP package `@lyrashield/mcp@0.2.12`, and no LyraShield account credentials. The sentinel credential was synthetic and the API URL pointed to loopback port 9. No LyraShield API request, tool call, scan, report, mutation, model session, or payment was made.

| Client surface   | Version              | Transport and tested capability                                                                   | Result and limit                                                                                                                                         |
| ---------------- | -------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI        | `0.159.0-alpha.12.1` | Native `codex mcp add`; isolated config readback for the exact pinned stdio command and arguments | Configuration was accepted and read back. Child initialization and `tools/list` were not run because those require a Codex thread or app-server session. |
| OpenCode CLI     | `1.18.30`            | Isolated `opencode mcp list` with stdio server                                                    | LyraShield server reported connected with the synthetic environment values. No LyraShield tool was called and authenticated use was not tested.          |
| Hermes Agent CLI | `0.21.1`             | Isolated `hermes mcp test` with stdio server                                                      | Connection succeeded and 21 tool names were discovered. No tool was called and authenticated use was not tested.                                         |

An OpenCode Desktop Computer Use check on 2026-10-02 opened a fresh session and invoked only
`lyrashield_list_workspaces`. The native client discovered and called the LyraShield MCP tool, but
the server returned `Authentication required`; no workspace data was returned. No credentials were
entered, and no target, scan, report, finding, billing or mutation tool was called. The desktop
runtime version was not independently read back (the installed host CLI reports `1.18.30`). This
confirms native tool discovery, not authenticated workspace access or end-to-end product acceptance.

- On 2026-09-28, npm published `@lyrashield/agent-plugin@0.1.30` and `lyrashield@0.2.13` from reviewed tarballs with SHA-256 `7eaa7335bf7c963a6af0d465b5d3a532cded9ac41b8767efd95e66a857fb98b1` and `2fbf951abfd59e29ba6dbbe5488c8e55a4679568334e41203ee137b2a5fe779a`. Registry SHA-1 checksums `c7c3ab6f2411c9737b1855bb558079dd971a4de0` and `6b19ef22cf1bb5e7903a6544b799ffd1580dc660` match those exact tarballs. A clean npm install imported the plugin and ran CLI `--version`/`--help` with lifecycle scripts disabled. This does not establish authenticated client activation or a marketplace release.
- On 2026-09-27, `npm view @lyrashield/mcp version dist-tags --json` reported `0.2.10` as latest; `npm view @lyrashield/mcp@0.2.10 dist.tarball dist.integrity --json` returned the [registry metadata](https://registry.npmjs.org/%40lyrashield%2fmcp/0.2.10). `npm pack --ignore-scripts` matched its SHA-512 integrity (`sha512-JbxgknLw96e+i1XtHmcrokLt3fidioZH9W9oElicLObLpelhwcXDPSgrWYCX6+K7NT1uyD1w6WPXR2ETegcppw==`) and included the stdio entrypoint. The [published package README](https://www.npmjs.com/package/@lyrashield/mcp/v/0.2.10?activeTab=readme) lists 21 tools; a stdio probe using a synthetic credential and local-only API URL returned MCP initialization and the same 21 `tools/list` names: `lyrashield_list_workspaces`, `lyrashield_list_targets`, `lyrashield_get_scan_status`, `lyrashield_get_scan_quality`, `lyrashield_get_scan_eligibility`, `lyrashield_scan_target`, `lyrashield_cancel_scan`, `lyrashield_get_findings`, `lyrashield_get_launch_readiness`, `lyrashield_create_report`, `lyrashield_check_diff`, `lyrashield_run_pr_scan`, `lyrashield_explain_finding`, `lyrashield_generate_fix_plan`, `lyrashield_record_fix_proposal`, `lyrashield_verify_fix`, `lyrashield_create_pr_security_recap`, `lyrashield_list_scan_attachments`, `lyrashield_upload_scan_attachment`, `lyrashield_delete_scan_attachment`, and `lyrashield_request_fix_pr`. `node scripts/verify-published-mcp.mjs` repeats identity, integrity, entrypoint, initialization and tool-list checks with npm lifecycle scripts disabled. Plugin version `0.1.30` remained unpublished at that time; npm returned `E404` for that version and remote tag `v0.1.30` was absent. Deliberate release updates must update generator, registry, templates, validator and snapshots together.
- On 2026-09-28, `node scripts/verify-published-mcp.mjs` passed the registry integrity, entrypoint, MCP initialization and stdio tool-list checks for published `@lyrashield/mcp@0.2.10` with npm lifecycle scripts disabled.
- On 2026-09-28, npm published `@lyrashield/mcp@0.2.11` from reviewed candidate `7a63a62a70da6ee1c8615488a04fbd18619eb5d4`. Registry metadata reports `0.2.11` as `latest`, SHA-1 `e1d017c1a72129b279c4e55681ee2fb7c352bc90`, and SHA-512 `sha512-3b/obQnbCx987TH2IbjF+UqkxEIHOpgDgvoVGCSvKpSOO2wcoF4bzhtHWzjOenhUDqp8iSCrj8ohJN9jDfyCbA==`, matching the reviewed tarball. A clean generated export ran `node scripts/verify-published-mcp.mjs` against this exact pin: registry integrity, fresh stdio initialization and 21-tool listing passed. This is a package/runtime protocol receipt, not authenticated client activation.
- [Kiro configuration](https://kiro.dev/docs/mcp/configuration/) specifies `.kiro/settings/mcp.json` for workspaces and `~/.kiro/settings/mcp.json` for users. Merge the exported stdio entry into one of these files; do not assume the staged plugin directory is discovered.
- [Gemini extension configuration](https://geminicli.com/docs/extensions/reference/) documents environment filtering and `${extensionPath}`. The optional `GEMINI_LYRASHIELD_CRED` setting passes through a Node preload using [npx's Node options](https://docs.npmjs.com/cli/v11/using-npm/config#node-options). The preload removes empty credentials and inherited OAuth overrides while preserving `LYRASHIELD_API_URL`. Zed embeds the same normalization. Stored OAuth refreshes against its stored issuer; an explicit extension API key uses only the canonical Cloud HTTPS origin.
- [Kilo configuration](https://kilo.ai/docs/automate/mcp/using-in-kilo-code) documents `mcp` entries with `type: local`, a command array and `environment`. The marketplace template uses `{env:LYRASHIELD_API_KEY}` instead of embedding a key.
- [Cursor plugin reference](https://prod.cursor.com/docs/reference/plugins) documents HTTP MCP URLs. Its [first-party install payload](https://cursor.com/install-mcp?config=eyJ0eXBlIjoiaHR0cCIsInVybCI6Imh0dHBzOi8vbWNwLmF0bGFzc2lhbi5jb20vdjEvbWNwIn0%3D&name=atlassian) uses `type: http`.
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) documents a direct server map or a wrapped `mcp_servers` map for the bundled MCP manifest. The Codex shim points to `.mcp.codex.json`, which uses the direct-map form and leaves authentication to hosted OAuth.

Pre-publication schema audit on 2026-10-02: the then-current npm plugin `0.1.30` tarball hashes to
`7eaa7335bf7c963a6af0d465b5d3a532cded9ac41b8767efd95e66a857fb98b1`; CLI `0.2.13` hashes to
`2fbf951abfd59e29ba6dbbe5488c8e55a4679568334e41203ee137b2a5fe779a`. Fetching the official
Agent Plugins MCP 1.0.0 schema produced SHA-256
`6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb`, matching the vendored
provenance. AJV 2020 rejects the published portable `mcp.json` at
`/mcpServers/lyrashield/type`: it contains `http`, while the portable remote schema requires
`streamable-http` (or the separate legacy SSE shape). The published CLI identifies the portable
root manifest and copies the entire package to `~/.cursor/plugins/local/lyrashield`; this does
not establish a schema-valid customer install path. The native Cursor shim is a distinct format
and does not prove the invalid advertised portable path works. This audit identified the transport
defect fixed in Agent Plugin `0.1.31`; the published `0.1.31` portable manifest now passes the
vendored official schema check. The audit's guidance to use MCP `0.2.11` and CLI `0.2.13` was
superseded by `0.2.12` / `0.2.14` publication on the same date. Marketplace listing and authenticated
client acceptance remain separate.

## Local native-client receipts — 2026-10-01

These checks used the fresh, unpublished Agent Plugin `0.1.31` export at
`/tmp/lyrashield-marketplace-wave2-final-20261001`. Its manifest records source commit
`671648fc256245b52899013c456dc7b3d9b7c1e6`, `publication.status: unpublished`, and
`publication.sourceClean: false`; this is a dirty-worktree local candidate, not a release export.
The export's `node scripts/validate.mjs` passed for 55 generated artifacts and 306 manifest file
records. Runtime identity is bound to each adapter-folder SHA-256 calculated from the export
manifest's sorted file records (`JSON.stringify(files)` for paths with the listed prefix):

| Client    | Version / platform                        | Adapter bundle SHA-256                                                               | Observed outcome                                                                                                                                                                                                                                                                                       | Limitation                                                                        |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Codex CLI | `codex-cli 0.159.2`, macOS `27.0.1` arm64 | `84570c962912bf630d8c9f7e57394f345425150fb44003622f7bbc705df7c5b6` (`codex-plugin/`) | With `CODEX_HOME` scoped to a fresh `/tmp` directory, added the local marketplace, listed `lyrashield@lyrashield-ai` at `0.1.31`, installed the plugin, confirmed it enabled, removed it, reinstalled it, and confirmed all six bundled skill files were present after both installs.                  | No OAuth login or workspace read call; the tested plugin version is unpublished.  |
| OpenCode  | `1.18.30`, macOS `27.0.1` arm64           | `2ba09f9102a824357da7bfa4bd0a79f7195f28a55ed346db323d933aedc2af6e` (`opencode/`)     | With `HOME`, `TMPDIR`, and all XDG paths scoped to a fresh `/tmp` directory, `debug config` resolved the hosted remote MCP URL and `lyrashield.read` scope, `debug skill` discovered the five focused workflows from `.opencode/skills`, and `mcp list` showed the endpoint as `needs authentication`. | No OAuth login or workspace read call; the tested adapter version is unpublished. |

These receipts confirm local package installation/configuration and component discovery for these exact
surfaces. They do not promote any registry tier to `NATIVE` or `VERIFIED`, and do not establish
authenticated runtime behavior, expiry/reconnect behavior, paid workflow behavior, or acceptance in
other products, IDEs, cloud surfaces, or marketplace listings.

Local checks cover generated configuration, exact package/version parity, secret exclusion, authorization wording and unset/empty/explicit extension credentials with inherited URL overrides. Still required: a successful authenticated `lyrashield_list_workspaces` call from OpenCode, tool discovery plus an authenticated read from Codex, runtime receipts for other claimed client surfaces, and forced-expiry OAuth sessions. These local receipts do not establish hosted or production acceptance.

## Prior package snapshot — 2026-09-28

The 2026-09-26 `pnpm pack` and `scripts/verify-agent-distribution.mjs --smoke` receipts passed for the prior coordinated release. The versions below were checked against npm registry readback and clean temporary installs on 2026-09-28. Support-tier words follow the agent registry (`NATIVE`/`VERIFIED` require CLIENT_RUNTIME evidence these receipts are not; `COMPATIBLE`/`EXPERIMENTAL` entries carry documentation or package-conformance evidence). These are package/config receipts, **not** live client acceptance. The latest package readback appears above.

| Package                    | Implementation | npm latest (obs.) | Transport                                | Support tier wording                                                         | Evidence                           | Verified   |
| -------------------------- | -------------- | ----------------- | ---------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- | ---------- |
| `lyrashield`               | 0.2.13         | 0.2.13            | cli                                      | Installer/driver for every registry tier                                     | packed, published, clean-installed | 2026-09-28 |
| `@lyrashield/mcp`          | 0.2.11         | 0.2.11            | stdio (hosted remote-http is app-served) | COMPATIBLE stdio/config clients; EXPERIMENTAL clients pending client-runtime | packed, published, stdio-checked   | 2026-09-28 |
| `@lyrashield/agent-plugin` | 0.1.30         | 0.1.30            | remote-http `mcp.json` + client shims    | Historical publication only; portable MCP schema fails current validation    | packed, published, clean-installed | 2026-09-28 |

Prior coordinated package release source: main `c6aee9ade4b4760c4280f3d6b3295fe50481d7f5` with [green CI](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36245760763). Verified tarball SHA-256: plugin `7e8c042174d63384b581b3f6fd90d2a51417179a63da5f57bc988e75cec7157e`, CLI `f44f0929a20483fa62eddba3533d523bab039860c497f7dafaec75a0ed9641f1`, MCP `385715ba589600edb1b27e8ba782047c06247e5c14e2a331bc76f48deb415b57`. Registry SHA-512 integrity matched each exact tarball. A clean npm install ran CLI `--version`/`--help` and imported the plugin; the published MCP passed integrity, entrypoint and stdio tool checks. The clean, release-candidate marketplace export validated 31 generated artifacts. Authenticated client-runtime acceptance remains separate. The newer MCP 0.2.11 receipt is recorded above.

## Future npm release procedure (maintainer-authorized)

As checked on 2026-10-02, there is **no** dedicated npm-publish GitHub workflow; the product workflows do not publish npm. Publication is a manual maintainer step; never store npm tokens in the repository.

The coordinated `@lyrashield/mcp@0.2.12`, `@lyrashield/agent-plugin@0.1.31`, and `lyrashield@0.2.14` packages are already published. For a future release, publish in dependency order **MCP → Agent Plugin → CLI**, update and verify exact pins, and review package bytes before publication. The CLI's packed manifest depends on the plugin through a resolved `^x.y.z` range (pnpm rewrites `workspace:^` at pack/publish time), so the plugin version must exist on npm before `npm install lyrashield` can resolve. MCP depends on neither package; release it first to keep new skills aligned with the stdio schema.

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
   ```

Update the relevant release receipt and regenerate the marketplace export so client pins match the published versions. Separately, from the root of that clean generated export, run:

```sh
node scripts/verify-published-mcp.mjs   # @lyrashield/mcp registry + stdio receipt
```

### Codebuff direct MCP and the candidate reviewer are separate contracts

On 2026-10-02, the [official Codebuff MCP guide](https://www.codebuff.com/docs/tips/mcp-servers)
explicitly documented project `.agents/mcp.json`, parent `.agents/mcp.json`, then global
`~/.agents/mcp.json` (later locations override earlier), under `mcpServers`, with local stdio
and HTTP/SSE entries plus `$VAR_NAME` shell interpolation. The registry config-file path matches
that current documented direct-MCP contract. Use published MCP `0.2.12` and separate CLI `0.2.14`
OAuth for the local fallback. Static remote headers are not evidence of hosted OAuth or authorization
for mutations.

The separate `codebuff/lyrashield-review.ts` preparation artifact uses per-agent `mcpServers`,
a read-only tool allowlist and published MCP `0.2.12` / CLI `0.2.14`. The Codebuff-specific agent
listing still needs a reviewed update and readback. This source review establishes the documented
configuration distinction, not authenticated Codebuff runtime acceptance.
