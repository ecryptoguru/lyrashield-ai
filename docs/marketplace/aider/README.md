# LyraShield AI alongside Aider

**State: PREPARATION.** This is a standalone CLI companion guide, not an Aider plugin or MCP manifest. No authenticated Aider runtime receipt or marketplace listing is claimed.

Aider documents read-only Markdown conventions but not a native MCP installation in the reviewed interface. Use [`CONVENTIONS.md`](./CONVENTIONS.md) with Aider's `/read` command or `--read` option; use the published LyraShield CLI `0.2.14` for checks. This remains a standalone companion workflow, not an Aider plugin or native MCP integration.

Authenticate with `npx -y lyrashield@0.2.14 login --oauth`. When the user asks for an advisory local review, `lyrashield check-diff --staged` checks staged changes without starting a recorded scan.

For recorded work, resolve and confirm the workspace and an authorized target first. `lyrashield use <workspaceId>` sets the workspace, and `lyrashield project list` shows targets in that workspace. Run the read-only preflight with the user's selected target and depth:

```sh
lyrashield preflight --target <targetId> --workspace <workspaceId> --goal CHECK_PR --mode QUICK
```

Only when the user explicitly requests the scan and the preflight allows it, start it against that same target and depth:

```sh
lyrashield pr-scan --target <targetId> --workspace <workspaceId> --mode QUICK --wait
```

Keep the returned scan ID and resume with `lyrashield status <scanId> --watch` if the session ends before a terminal result. Do not use automatic target detection in this guide. No hook is installed by this bundle.

Sources: [Aider conventions](https://aider.chat/docs/usage/conventions.html), [Aider config](https://aider.chat/docs/config/aider_conf.html), [LyraShield CLI reference](../../../packages/cli/README.md).
