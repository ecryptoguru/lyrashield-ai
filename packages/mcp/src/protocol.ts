import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js"

/**
 * Protocol truth comes from the installed official SDK. Keep unsupported draft
 * features false until the SDK exposes stable schemas and transport behavior.
 */
export const MCP_PROTOCOL_SUPPORT = Object.freeze({
  latestStable: LATEST_PROTOCOL_VERSION,
  supported: Object.freeze([...SUPPORTED_PROTOCOL_VERSIONS]),
  serverDiscovery: false,
  listCacheMetadata: false,
  durableTasks: false,
})
