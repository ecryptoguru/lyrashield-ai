# Client configuration receipts

Updated 2026-10-01. Historical package readbacks remain dated at the time they were collected;
current local native-client receipts are recorded below. They do not establish authenticated access
or public marketplace acceptance.

- On 2026-09-28, npm published `@lyrashield/agent-plugin@0.1.30` and `lyrashield@0.2.13` from reviewed tarballs with SHA-256 `7eaa7335bf7c963a6af0d465b5d3a532cded9ac41b8767efd95e66a857fb98b1` and `2fbf951abfd59e29ba6dbbe5488c8e55a4679568334e41203ee137b2a5fe779a`. Registry SHA-1 checksums `c7c3ab6f2411c9737b1855bb558079dd971a4de0` and `6b19ef22cf1bb5e7903a6544b799ffd1580dc660` match those exact tarballs. A clean npm install imported the plugin and ran CLI `--version`/`--help` with lifecycle scripts disabled. This does not establish authenticated client activation or a marketplace release.
- On 2026-09-27, `npm view @lyrashield/mcp version dist-tags --json` reported `0.2.10` as latest; `npm view @lyrashield/mcp@0.2.10 dist.tarball dist.integrity --json` returned the [registry metadata](https://registry.npmjs.org/%40lyrashield%2fmcp/0.2.10). `npm pack --ignore-scripts` matched its SHA-512 integrity (`sha512-JbxgknLw96e+i1XtHmcrokLt3fidioZH9W9oElicLObLpelhwcXDPSgrWYCX6+K7NT1uyD1w6WPXR2ETegcppw==`) and included the stdio entrypoint. The [published package README](https://www.npmjs.com/package/@lyrashield/mcp/v/0.2.10?activeTab=readme) lists 21 tools; a stdio probe using a synthetic credential and local-only API URL returned MCP initialization and the same 21 `tools/list` names: `lyrashield_list_workspaces`, `lyrashield_list_targets`, `lyrashield_get_scan_status`, `lyrashield_get_scan_quality`, `lyrashield_get_scan_eligibility`, `lyrashield_scan_target`, `lyrashield_cancel_scan`, `lyrashield_get_findings`, `lyrashield_get_launch_readiness`, `lyrashield_create_report`, `lyrashield_check_diff`, `lyrashield_run_pr_scan`, `lyrashield_explain_finding`, `lyrashield_generate_fix_plan`, `lyrashield_record_fix_proposal`, `lyrashield_verify_fix`, `lyrashield_create_pr_security_recap`, `lyrashield_list_scan_attachments`, `lyrashield_upload_scan_attachment`, `lyrashield_delete_scan_attachment`, and `lyrashield_request_fix_pr`. `node scripts/verify-published-mcp.mjs` repeats identity, integrity, entrypoint, initialization and tool-list checks with npm lifecycle scripts disabled. Plugin version `0.1.30` remained unpublished at that time; npm returned `E404` for that version and remote tag `v0.1.30` was absent. Deliberate release updates must update generator, registry, templates, validator and snapshots together.
- On 2026-09-28, `node scripts/verify-published-mcp.mjs` passed the registry integrity, entrypoint, MCP initialization and stdio tool-list checks for published `@lyrashield/mcp@0.2.10` with npm lifecycle scripts disabled.
- On 2026-09-28, npm published `@lyrashield/mcp@0.2.11` from reviewed candidate `7a63a62a70da6ee1c8615488a04fbd18619eb5d4`. Registry metadata reports `0.2.11` as `latest`, SHA-1 `e1d017c1a72129b279c4e55681ee2fb7c352bc90`, and SHA-512 `sha512-3b/obQnbCx987TH2IbjF+UqkxEIHOpgDgvoVGCSvKpSOO2wcoF4bzhtHWzjOenhUDqp8iSCrj8ohJN9jDfyCbA==`, matching the reviewed tarball. A clean generated export ran `node scripts/verify-published-mcp.mjs` against this exact pin: registry integrity, fresh stdio initialization and 21-tool listing passed. This is a package/runtime protocol receipt, not authenticated client activation.
- [Kiro configuration](https://kiro.dev/docs/mcp/configuration/) specifies `.kiro/settings/mcp.json` for workspaces and `~/.kiro/settings/mcp.json` for users. Merge the exported stdio entry into one of these files; do not assume the staged plugin directory is discovered.
- [Gemini extension configuration](https://geminicli.com/docs/extensions/reference/) documents environment filtering and `${extensionPath}`. The optional `GEMINI_LYRASHIELD_CRED` setting passes through a Node preload using [npx's Node options](https://docs.npmjs.com/cli/v11/using-npm/config#node-options). The preload removes empty credentials and inherited OAuth overrides while preserving `LYRASHIELD_API_URL`. Zed embeds the same normalization. Stored OAuth refreshes against its stored issuer; an explicit extension API key uses only the canonical Cloud HTTPS origin.
- [Kilo configuration](https://kilo.ai/docs/automate/mcp/using-in-kilo-code) documents `mcp` entries with `type: local`, a command array and `environment`. The marketplace template uses `{env:LYRASHIELD_API_KEY}` instead of embedding a key.
- [Cursor plugin reference](https://prod.cursor.com/docs/reference/plugins) documents HTTP MCP URLs. Its [first-party install payload](https://cursor.com/install-mcp?config=eyJ0eXBlIjoiaHR0cCIsInVybCI6Imh0dHBzOi8vbWNwLmF0bGFzc2lhbi5jb20vdjEvbWNwIn0%3D&name=atlassian) uses `type: http`.
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) documents a direct server map or a wrapped `mcp_servers` map for the bundled MCP manifest. The Codex shim points to `.mcp.codex.json`, which uses the direct-map form and leaves authentication to hosted OAuth.

## Local native-client receipts — 2026-10-01

These checks used the fresh generated, unpublished Agent Plugin `0.1.31` export from source commit
`b92dabdb2f96ceef33e0ddca8eeacf7676590552`; the worktree was dirty, so this was a local candidate,
not a release export. The root validator passed for 55 generated artifacts and 306 file records.
Runtime identity is bound to the adapter-folder SHA-256 calculated from the export manifest's sorted
file records (`JSON.stringify(files)` for paths with the listed prefix):

| Client    | Version / platform              | Adapter bundle SHA-256                                                               | Observed outcome                                                                                                                                                                                                                                      | Limitation                                                                                          |
| --------- | ------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Codex CLI | `0.159.2`, macOS `27.0.1` arm64 | `d351ab6f04548fe638108cbfabc3142e865b9b66e6cd879705b6961b45fa43d1` (`codex-plugin/`) | Added the local marketplace, listed `lyrashield@lyrashield-ai` at `0.1.31`, installed it in a disposable `CODEX_HOME`, and confirmed the installed plugin was enabled with all six bundled skill files present, including the five focused workflows. | No authenticated OAuth connection or workspace read call; the tested plugin version is unpublished. |
| OpenCode  | `1.18.30`, macOS `27.0.1` arm64 | `2291654a0531da842829881ff5492376bed44f57b4a37b933d569b0c55b5d84a` (`opencode/`)     | In an isolated project, `debug config` resolved the hosted remote MCP entry and read scope, `debug skill` discovered all five focused workflows from `.opencode/skills`, and `mcp list` showed the endpoint as `needs authentication`.                | No OAuth login or workspace read call; the tested adapter version is unpublished.                   |

These receipts confirm local package installation/configuration and component discovery for these exact
surfaces. They do not promote any registry tier to `NATIVE` or `VERIFIED`, and do not establish
authenticated runtime behavior, expiry/reconnect behavior, paid workflow behavior, or acceptance in
other products, IDEs, cloud surfaces, or marketplace listings.

Local checks cover generated configuration, exact package/version parity, secret exclusion, authorization wording and unset/empty/explicit extension credentials with inherited URL overrides. Still required: authenticated `lyrashield_list_workspaces` calls for Codex and OpenCode, runtime receipts for other claimed client surfaces, and forced-expiry OAuth sessions. These local receipts do not establish hosted or production acceptance.

## Distribution capability matrix

The 2026-09-26 `pnpm pack` and `scripts/verify-agent-distribution.mjs --smoke` receipts passed for the prior coordinated release. The current package versions below were checked against npm registry readback and clean temporary installs on 2026-09-28. Support-tier words follow the agent registry (`NATIVE`/`VERIFIED` require CLIENT_RUNTIME evidence these receipts are not; `COMPATIBLE`/`EXPERIMENTAL` entries carry documentation or package-conformance evidence). These are package/config receipts, **not** live client acceptance.

| Package                    | Implementation | npm latest (obs.) | Transport                                | Support tier wording                                                         | Evidence                           | Verified   |
| -------------------------- | -------------- | ----------------- | ---------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- | ---------- |
| `lyrashield`               | 0.2.13         | 0.2.13            | cli                                      | Installer/driver for every registry tier                                     | packed, published, clean-installed | 2026-09-28 |
| `@lyrashield/mcp`          | 0.2.11         | 0.2.11            | stdio (hosted remote-http is app-served) | COMPATIBLE stdio/config clients; EXPERIMENTAL clients pending client-runtime | packed, published, stdio-checked   | 2026-09-28 |
| `@lyrashield/agent-plugin` | 0.1.30         | 0.1.30            | remote-http `mcp.json` + client shims    | Preferred for plugin-capable COMPATIBLE clients; Copilot stays EXPERIMENTAL  | packed, published, clean-installed | 2026-09-28 |

Prior coordinated package release source: main `c6aee9ade4b4760c4280f3d6b3295fe50481d7f5` with [green CI](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36245760763). Verified tarball SHA-256: plugin `7e8c042174d63384b581b3f6fd90d2a51417179a63da5f57bc988e75cec7157e`, CLI `f44f0929a20483fa62eddba3533d523bab039860c497f7dafaec75a0ed9641f1`, MCP `385715ba589600edb1b27e8ba782047c06247e5c14e2a331bc76f48deb415b57`. Registry SHA-512 integrity matched each exact tarball. A clean npm install ran CLI `--version`/`--help` and imported the plugin; the published MCP passed integrity, entrypoint and stdio tool checks. The clean, release-candidate marketplace export validated 31 generated artifacts. Authenticated client-runtime acceptance remains separate. The newer MCP 0.2.11 receipt is recorded above.

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
   ```

   Update the npm column above and regenerate the marketplace export so client pins match the published versions. Separately, from the root of that clean generated export, run:

   ```sh
   node scripts/verify-published-mcp.mjs   # @lyrashield/mcp registry + stdio receipt
   ```
