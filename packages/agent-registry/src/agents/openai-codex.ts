import type { AgentEntry } from "../types"
import {
  API_URL_PLACEHOLDER,
  CLI_PACKAGE_SPEC,
  MCP_PACKAGE_SPEC,
  LAST_AGENT_REGISTRY_CHECK_DATE,
} from "./shared"

export const openaiCodex: AgentEntry = {
  id: "openai-codex",
  displayName: "OpenAI Codex",
  docsSlug: "openai-codex",
  installStrategy: "config-file",
  format: "toml",
  rootKey: "mcp_servers",
  locations: [
    {
      scope: "global",
      path: "~/.codex/config.toml",
      sharedByConvention: false,
    },
  ],
  transports: ["stdio", "remote-http"],
  remoteAuth: "oauth",
  remoteAuthConfig: {
    apiKeyEnvVar: "LYRASHIELD_API_KEY",
    bearerTokenEnvVarField: "bearer_token_env_var",
    headersField: "http_headers",
  },
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { url: API_URL_PLACEHOLDER },
  },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: "2026-10-02",
    url: "https://developers.openai.com/codex/mcp",
  },
  gotchas: [
    "Explicit values belong in `[mcp_servers.lyrashield.env]`. Codex reserves `env_vars` for an array of environment-variable names inherited from the parent process.",
    "Codex remote MCP authentication uses `bearer_token_env_var` or `http_headers`; a `headers` table is not the documented field.",
  ],
}

export const openaiCodexPlugin: AgentEntry = {
  id: "openai-codex-agent-plugin",
  displayName: "OpenAI Codex (Agent Plugin)",
  docsSlug: "openai-codex",
  installStrategy: "agent-plugin",
  format: null,
  rootKey: null,
  locations: [],
  pluginLocations: [
    {
      scope: "global",
      path: "~/.codex/plugins/lyrashield",
      sharedByConvention: false,
    },
  ],
  transports: ["remote-http"],
  credential: { kind: "ui-fields" },
  manualInstructions: `The Agent Plugin package is published, but the OpenAI Codex public listing and authenticated runtime acceptance remain pending. Do not install from the mutable marketplace preparation branch. Use the current direct-MCP fallback: merge the [mcp_servers.lyrashield] stdio table into ~/.codex/config.toml with command npx and args ["-y", "${MCP_PACKAGE_SPEC}"], preserving existing entries. Authenticate separately with npx -y ${CLI_PACKAGE_SPEC} login --oauth in the same OS account, restart Codex, confirm server/tool discovery, then call lyrashield_list_workspaces. See /docs/integrations/openai-codex.`,
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://developers.openai.com/codex/plugins/build",
  },
  gotchas: [
    "The marketplace preparation branch is not a released install artifact. Use the pinned stdio MCP fallback until a reviewed immutable plugin release exists.",
    "Local CLI OAuth authentication, Codex server discovery and a successful authenticated read are separate checks.",
  ],
}
