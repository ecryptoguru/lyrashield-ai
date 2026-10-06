import type { AgentEntry } from "../types"
import {
  API_URL_PLACEHOLDER,
  CLI_PACKAGE_SPEC,
  MCP_PACKAGE_SPEC,
  LAST_AGENT_REGISTRY_CHECK_DATE,
} from "./shared"

export const vscode: AgentEntry = {
  id: "vscode",
  displayName: "GitHub Copilot in VS Code (MCP config)",
  productFamily: { id: "github-copilot", name: "GitHub Copilot" },
  surface: "ide",
  docsSlug: "vscode",
  installStrategy: "config-file",
  format: "json",
  rootKey: "servers",
  locations: [
    {
      scope: "project",
      path: ".vscode/mcp.json",
      sharedByConvention: true,
    },
  ],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    stdio: { type: "stdio" },
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: [".github/copilot-instructions.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
  },
  gotchas: [
    "VS Code uses `servers`, not `mcpServers`; using `mcpServers` silently fails.",
    'VS Code stdio entries require `type: "stdio"`; remote entries use `type: "http"`.',
    "For a user-profile server, run MCP: Open User Configuration or MCP: Add Server. VS Code owns the profile-specific mcp.json path, so do not edit settings.json for MCP configuration.",
  ],
}

export const copilotCli: AgentEntry = {
  id: "copilot-cli",
  displayName: "GitHub Copilot CLI",
  productFamily: { id: "github-copilot", name: "GitHub Copilot" },
  docsSlug: "copilot-cli",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "global",
      path: "~/.copilot/mcp-config.json",
      sharedByConvention: false,
    },
    {
      scope: "project",
      path: ".mcp.json",
      sharedByConvention: true,
    },
    {
      scope: "project",
      path: ".github/mcp.json",
      sharedByConvention: true,
    },
  ],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    stdio: { type: "local" },
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  vendorCli: { command: "copilot", args: ["mcp", "add"] },
  rulesFiles: [".github/copilot-instructions.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
  },
  gotchas: [
    'Copilot CLI stdio entries use `type: "local"` (or `"stdio"`); remote uses `type: "http"`.',
    'Each entry may carry a `tools` array (e.g. ["*"]) to allowlist server tools.',
    "GitHub's own MCP server is built in — you don't add it manually.",
  ],
}

export const githubCopilotCloudAgent: AgentEntry = {
  id: "github-copilot-cloud-agent",
  displayName: "GitHub Copilot Cloud Agent",
  productFamily: { id: "github-copilot", name: "GitHub Copilot" },
  surface: "cloud",
  docsSlug: "github-copilot-cloud-agent",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["remote-http"],
  preferredTransport: "remote-http",
  remoteAuth: "api-key",
  credential: { kind: "ui-fields" },
  nativeCapabilities: ["plugin", "skills"],
  skillLocations: [{ scope: "project", path: ".github/skills", sharedByConvention: true }],
  skillInstallState: "withheld",
  distribution: {
    channel: "GitHub Copilot read-only MCP; surface-safe workflow skills pending validation",
    url: "https://docs.github.com/en/copilot/concepts/agents/cloud-agent/mcp-and-cloud-agent",
    state: "PREPARATION",
  },
  manualInstructions:
    'Skill installation is withheld because the published workflow set has not yet been reduced and validated for this read-only surface. Do not copy skills from the mutable preparation branch into `.github/skills/`. The intended read-only set is `get-started`, `review-changes` and `launch-readiness`; use direct MCP tools meanwhile. Do not enable the full marketplace plugin: it includes workflows and an OAuth MCP descriptor that this surface cannot use. Skill discovery is separate from MCP authentication. Allow only the read-only tools `lyrashield_check_diff`, `lyrashield_get_launch_readiness`, `lyrashield_list_targets` and `lyrashield_list_workspaces`. Configure the remote server separately in GitHub repository Settings → Code, planning and automation → Copilot → MCP servers with `type: "http"`, `url: "https://app.lyrashieldai.com/api/mcp" and `headers.Authorization: "Bearer $COPILOT_MCP_LYRASHIELD_API_KEY"`. Create a read-only LyraShield workspace API key and save it as an Agents secret named `COPILOT_MCP_LYRASHIELD_API_KEY` under Settings → Security → Secrets and variables → Agents. Omit `*` because GitHub lets Cloud Agent use configured tools autonomously. Do not install `scan-project`, `fix-and-retest` or the backward-compatible `lyrashield` skill on this read-only surface; requested recorded scans, fixes and retests require an OAuth-capable client. The optional recorded scan action in `review-changes` is not allowlisted. Copilot Cloud Agent does not support remote OAuth, and hosted mutations still return `connect_required`. This documentation-only entry has no authenticated Cloud Agent runtime receipt.',
  rulesFiles: [".github/copilot-instructions.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.github.com/en/copilot/concepts/agents/cloud-agent/mcp-and-cloud-agent",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.github.com/en/copilot/concepts/agents/cloud-agent/mcp-and-cloud-agent",
    receipt: null,
  },
  gotchas: [
    "Cloud Agent and Copilot code review share repository MCP settings; configured MCP tools are used autonomously, so allowlist read-only tools and review the target repository before enabling them.",
    "The planned read-only skill set, withheld until a surface-safe bundle is validated, is `get-started`, `review-changes` and `launch-readiness`; the tool allowlist includes only read-only calls. Recorded scans, fixes and retests require an OAuth-capable client.",
    "GitHub documents `$COPILOT_MCP_...` substitutions for remote headers and requires those values to come from Agents secrets or variables. The key authenticates read-only calls; it cannot grant hosted mutations, which return `connect_required` without a connected OAuth delegation.",
    "Remote MCP OAuth is not supported by Copilot Cloud Agent. Portable plugin and skills discovery is separate from service authentication; a plugin install or skill discovery is not evidence that the LyraShield MCP server connected.",
  ],
}

export const vscodePlugin: AgentEntry = {
  id: "vscode-agent-plugin",
  displayName: "GitHub Copilot in VS Code (Agent Plugin)",
  productFamily: { id: "github-copilot", name: "GitHub Copilot" },
  surface: "ide",
  docsSlug: "vscode-agent-plugin",
  installStrategy: "agent-plugin",
  format: null,
  rootKey: null,
  locations: [],
  pluginLocations: [
    {
      scope: "global",
      path: "~/.lyrashield/plugins/lyrashield",
      sharedByConvention: false,
    },
  ],
  transports: ["remote-http"],
  credential: { kind: "ui-fields" },
  nativeCapabilities: ["plugin", "skills", "commands", "rules", "hooks"],
  manualInstructions:
    "VS Code Agent Plugin setup is manual: the LyraShield CLI returns MANUAL_REQUIRED and does not install or register this plugin. The package is published, but a public listing and authenticated client runtime acceptance remain pending. Do not use the mutable marketplace preparation branch. Until those checks pass, manually merge the VS Code MCP fallback into `.vscode/mcp.json`, preserving existing servers and settings. Plugin installation, client discovery, OAuth authentication and a read-only call are separate checks.",
  rulesFiles: [".github/copilot-instructions.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://code.visualstudio.com/docs/agent-customization/agent-plugins",
  },
  gotchas: [
    "VS Code reads the portable root `plugin.json`; there is no VS Code-specific shim directory. Our manifest declares the Agent Plugins 1.0 `$schema`, so VS Code classifies it as Agent Plugins 1.0 and takes MCP servers from the root `mcp.json`.",
    "Auto-registration is NOT wired yet, so this path is a staging copy rather than a discovery path. VS Code only auto-discovers plugins under `~/.copilot/installed-plugins/`; everything else arrives via a configured marketplace, Install-from-Source or an explicit entry in the `chat.pluginLocations` setting.",
    "If plugin installation is unavailable, use the documented `.vscode/mcp.json` MCP configuration fallback. Agent plugins additionally require the `chat.plugins.enabled` setting. Configuration does not establish authenticated client acceptance.",
    "Authenticate through the client-hosted OAuth flow when connecting the remote MCP server.",
  ],
}

export const githubCopilotPlugin: AgentEntry = {
  id: "github-copilot-agent-plugin",
  displayName: "GitHub Copilot (Agent Plugin)",
  productFamily: { id: "github-copilot", name: "GitHub Copilot" },
  docsSlug: "github-copilot",
  installStrategy: "agent-plugin",
  format: null,
  rootKey: null,
  locations: [],
  pluginLocations: [
    {
      scope: "global",
      path: "~/.copilot/plugins/lyrashield",
      sharedByConvention: false,
    },
  ],
  transports: ["remote-http"],
  credential: { kind: "ui-fields" },
  manualInstructions: `The Agent Plugin package is published, but the GitHub Copilot public listing and authenticated runtime acceptance remain pending. Do not install from the mutable marketplace preparation branch. Use the current direct-MCP fallback: merge mcpServers.lyrashield into ~/.copilot/mcp-config.json with type "local", command npx and args ["-y", "${MCP_PACKAGE_SPEC}"], preserving other servers. Authenticate separately with npx -y ${CLI_PACKAGE_SPEC} login --oauth in the same OS account, restart Copilot CLI, use /mcp show lyrashield to confirm discovery, then call lyrashield_list_workspaces. See /docs/integrations/github-copilot.`,
  rulesFiles: [".github/copilot-instructions.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.github.com/en/copilot/concepts/agents/about-plugins",
  },
  gotchas: [
    "GitHub Copilot CLI scans each plugin directory for a `plugin.json` manifest at the root.",
    "For the current stdio fallback, local CLI OAuth, client discovery and an authenticated read are separate checks.",
  ],
}
