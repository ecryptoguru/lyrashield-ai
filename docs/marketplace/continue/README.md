# LyraShield AI for Continue — preparation

**State: PREPARATION.** The local MCP block, rule, and slash prompts are staged for review. `@lyrashield/mcp@0.2.12` is published, but no Continue Hub entry or authenticated client-runtime receipt is confirmed.

## Install the local integration

The bundle uses Continue's documented project MCP-block format. This route starts the pinned LyraShield stdio server locally, so it works with the CLI credential store and does not put a key in project configuration. The MCP server requires Node.js 24 or newer. First authenticate with `lyrashield login` in the same OS account that runs Continue, then copy the files into the project without replacing existing files:

```sh
mkdir -p .continue/mcpServers .continue/rules
cp docs/marketplace/continue/mcpServers/lyrashield.yaml .continue/mcpServers/lyrashield.yaml
cp docs/marketplace/continue/rules/lyrashield.md .continue/rules/lyrashield.md
```

If a destination exists, inspect and merge it manually. The MCP block needs Continue Agent mode. Restart or reload the extension, then confirm LyraShield tools appear before asking for a read-only workspace/target lookup. Keep client tool approvals enabled. A prompt can guide a workflow; it does not override LyraShield authorization.

The prompt files use Continue's documented `invokable: true` frontmatter. Register each file in the existing Continue `config.yaml` using the documented `prompts:` file reference, replacing the path with the location where you keep this bundle:

```yaml
prompts:
  - uses: file://user/path/to/continue/prompts/review-changes.md
  - uses: file://user/path/to/continue/prompts/scan-project.md
```

Do not assume a `.continue/prompts/` directory is automatically discovered. The repo-hosted Continue Hub can distribute shared model, rule, prompt, and MCP blocks, but this LyraShield package has not been submitted or read back there.

This package deliberately uses local stdio. Continue documents remote Streamable HTTP MCP, but the current official setup material reviewed here did not establish hosted OAuth/Dynamic Client Registration behavior for Continue. Do not replace this with a hosted URL or static credential header without a separately verified auth path.

## Workflows

- `/get-started` connects the workflow to one selected workspace and stays read-only.
- `/review-changes` uses the read-only advisory diff check; a recorded Quick scan is opt-in.
- `/scan-project` starts work only after an explicit user request and retains the operation ID.
- `/fix-and-retest` leaves fixes as proposals until trusted retest evidence is available.
- `/launch-readiness` reports the evidence and gates that exist without inventing an assurance claim.

## Verification and sources

Contract research was checked on 2026-10-01. No Continue client was authenticated or tested, and no Hub application was submitted. See [Continue's MCP blocks](https://docs.continue.dev/customize/deep-dives/mcp), [YAML config reference](https://docs.continue.dev/reference), [rules](https://docs.continue.dev/customize/deep-dives/rules), [prompts](https://docs.continue.dev/customize/deep-dives/prompts), and [Continue CLI configuration](https://docs.continue.dev/cli/configuration).
