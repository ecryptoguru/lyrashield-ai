# LyraShield AI for OpenCode

OpenCode-native setup using the shared portable skills and a remote OAuth MCP connection. The
exporter keeps each workflow skill identical to its canonical source; no OpenCode-specific fork is
maintained.

## Install OpenCode stable

Use OpenCode's stable installer, then check the installed CLI:

```sh
curl -fsSL https://opencode.ai/install | bash
opencode --version
```

OpenCode's stable docs list project skills at `.opencode/skills/<name>/SKILL.md` and global
skills at `~/.config/opencode/skills/<name>/SKILL.md`. Stable discovery uses local files; copy the
skill into one of those locations.

## Install the shared skills

Install the skills from `opencode/skills` in this released bundle through LyraShield's
checksum-aware installer. It preserves customized and unrelated skill files:

```sh
lyrashield skills install opencode --global
# For project discovery instead:
lyrashield skills install opencode --project
```

The installer places project skills in `.opencode/skills/` and global skills in
`~/.config/opencode/skills/`. Restart OpenCode and confirm the LyraShield workflows appear among
available skills. Upgrade with the same command; remove LyraShield-owned files with
`lyrashield skills remove opencode --global` or `--project`.

## Configure OAuth MCP

Merge [opencode.json](./opencode.json) into `opencode.json` at your project root or
`~/.config/opencode/opencode.json`. It uses the hosted Streamable HTTP MCP endpoint and requests
only `lyrashield.read`; it contains no API key, client secret or bearer header. Authenticate with
`opencode mcp auth lyrashield`, then inspect connection state with `opencode mcp list`. OpenCode
performs OAuth and keeps tokens in its own credential store. Run `opencode mcp logout lyrashield`
to remove the stored connection.

The read-only scope limits access to read operations. Mutating workflows require an explicit
`lyrashield.write` grant plus workspace permissions and any workflow-specific authorization. Do not
add that scope unless those writes are intended.

## Support boundary

OpenCode stable documents native skill discovery, remote MCP, OAuth and dynamic client
registration. The configuration matches those documented interfaces and LyraShield's current
OAuth endpoint, but authenticated OpenCode client runtime acceptance, expiry/reconnect behavior,
and marketplace listing are not verified by this artifact. Treat those as pending until tested in
the released OpenCode client.

Sources: [OpenCode installation](https://opencode.ai/docs), [Agent Skills](https://opencode.ai/docs/skills/),
and [MCP servers](https://opencode.ai/docs/mcp-servers/).
