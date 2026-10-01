# LyraShield AI alongside Aider

**State: PREPARATION.** This is a standalone CLI companion guide, not an Aider plugin or MCP manifest. No authenticated Aider runtime receipt or marketplace listing is claimed.

Aider documents read-only Markdown conventions but not a native MCP installation in the reviewed interface. Use [`CONVENTIONS.md`](./CONVENTIONS.md) with Aider's `/read` command or `--read` option; use LyraShield CLI for checks. The staged CLI pin `lyrashield@0.2.14` is unpublished; wait for the coordinated release.

After release, authenticate with `npx -y lyrashield@0.2.14 login --oauth`. `lyrashield check-diff --staged` is an advisory local diff check; `lyrashield preflight --target <targetId> --goal CHECK_PR --mode QUICK` is read-only. Only on explicit request start recorded work with `lyrashield pr-scan --auto --wait`. Keep its scan ID and resume with `lyrashield status <scanId> --watch` if the session ends. No hook is installed by this bundle.

Sources: [Aider conventions](https://aider.chat/docs/usage/conventions.html), [Aider config](https://aider.chat/docs/config/aider_conf.html), [LyraShield CLI reference](../../../packages/cli/README.md).
