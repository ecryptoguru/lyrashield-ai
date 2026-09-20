/**
 * Connector tool registry — the approved server/tool allowlist for outbound
 * scan context. A tool absent from this registry is not invocable; every
 * registered tool is read-only by contract and by the provider transport it
 * uses (GET-only calls, scope-bound credentials).
 */
import { githubConnectorTools } from "./github"
import { slackConnectorTools } from "./slack"
import type { ConnectorProvider, ConnectorTool } from "./types"

export const CONNECTOR_TOOLS: readonly ConnectorTool[] = [
  ...githubConnectorTools,
  ...slackConnectorTools,
]

const TOOL_INDEX = new Map(CONNECTOR_TOOLS.map((tool) => [tool.name, tool]))

export function getConnectorTool(name: string): ConnectorTool | undefined {
  return TOOL_INDEX.get(name)
}

export function listConnectorTools(provider?: ConnectorProvider): ConnectorTool[] {
  return provider
    ? CONNECTOR_TOOLS.filter((tool) => tool.provider === provider)
    : [...CONNECTOR_TOOLS]
}

/**
 * The provider resource a validated tool input targets, used for the
 * connection's resource-scope check. `undefined` means the tool operates at
 * workspace level (e.g. `slack.list_channels`) — resource allowlists only
 * constrain tools that name one.
 */
export function connectorToolResource(
  tool: ConnectorTool,
  input: Record<string, unknown>
): string | undefined {
  if (
    tool.provider === "github" &&
    typeof input.owner === "string" &&
    typeof input.repo === "string"
  ) {
    return `repo:${input.owner}/${input.repo}`
  }
  if (tool.provider === "slack" && typeof input.channel === "string") {
    return `channel:${input.channel}`
  }
  return undefined
}
