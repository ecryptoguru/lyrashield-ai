# LyraShield AI for Goose

**State: PREPARATION.** Config and shared skills are staged for review; Goose runtime acceptance and LyraShield directory listing are unverified. The hosted URL is the current LyraShield MCP service.

Merge [`config.yaml`](./config.yaml) into `~/.config/goose/config.yaml` (macOS/Linux) or `%APPDATA%\Block\goose\config\config.yaml` (Windows). Preserve existing `extensions` entries. Goose supports this Streamable HTTP extension shape and OAuth; connect through `goose configure` or Goose Desktop and complete consent in the browser. Do not put credentials in YAML.

Copy selected skill folders from [`skills/`](./skills/) into project `.agents/skills/` or user `~/.agents/skills/`. Verify Goose discovers the server and skills, then make a read-only workspace call. A scan still requires an explicit request.

Sources: [configuration files](https://goose-docs.ai/docs/guides/config-files/), [extensions and OAuth](https://goose-docs.ai/docs/getting-started/using-extensions/), [Agent Skills](https://goose-docs.ai/docs/guides/context-engineering/using-skills/).
