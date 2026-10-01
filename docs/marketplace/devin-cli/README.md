# LyraShield AI for Devin CLI and plugins

**State: PREPARATION.** This Agent Plugins v1 package has unpublished plugin version `0.1.31`; no Devin CLI, cloud, or Desktop runtime receipt or public listing is confirmed. The hosted endpoint is the current LyraShield MCP service.

For local testing, use Devin's documented local install from a checkout:

```sh
devin plugins install --local ./docs/marketplace/devin-cli/plugin
devin plugins list
devin plugins info lyrashield
devin mcp login lyrashield
```

Review the package before enabling it. After the prepared source is merged and publicly available, Devin supports a repository-subdirectory install such as `devin plugins install ecryptoguru/lyrashield-ai#docs/marketplace/devin-cli/plugin`. Do not use that candidate path before it exists on the selected public ref.

CLI plugin OAuth uses `devin mcp login lyrashield`. Cloud sessions use the connection configured in Devin's web app and organization policy; this CLI command is not cloud setup or cloud acceptance. Devin Desktop's legacy Cascade uses a separate file documented in [`devin-desktop`](../devin-desktop/README.md); the Local Agent uses the CLI/plugin path.

Sources: [Devin CLI plugin format, OAuth, cloud and Desktop boundaries](https://docs.devin.ai/cli/extensibility/plugins/overview), [Devin Desktop Cascade MCP](https://docs.devin.ai/desktop/cascade/mcp).
