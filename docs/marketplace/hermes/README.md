# LyraShield AI for Hermes Agent

**State: PREPARATION.** This package and config are release candidates; no authenticated Hermes runtime receipt or Plugin Catalog listing is confirmed. `@lyrashield/mcp@0.2.12`, CLI `lyrashield@0.2.14`, and plugin `0.1.31` are unpublished candidates. Wait for the coordinated release before installing those package versions.

[`plugin/`](./plugin/) contains the shared skills and a local stdio MCP server. After release, run `npx -y lyrashield@0.2.14 login --oauth`, then:

```sh
hermes plugins install --local /path/to/lyrashield-ai/docs/marketplace/hermes/plugin --no-enable
hermes plugins enable lyrashield
hermes plugins list
```

Hermes keeps installed plugins disabled until explicitly enabled. Review the package before enabling it. Use `skills_list` to discover namespaced skills.

For hosted OAuth instead, merge [`hermes-mcp.yaml`](./hermes-mcp.yaml) into `~/.hermes/config.yaml`. A config-level server named `lyrashield` takes precedence over the package server of the same name; choose one transport. Do not put credentials in config.

The candidate has not been runtime-tested or submitted to the Hermes catalog. Catalog eligibility requires a released public repo and reviewed commit pin.

Sources: [portable Agent Plugins](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins), [MCP configuration and OAuth](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference), [catalog submission](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugin-catalog), [skills](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills/).
