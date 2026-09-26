import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server"

/**
 * Protocol truth comes from the installed official SDK. Do not advertise
 * optional features until their LyraShield handlers are implemented.
 */
export const MCP_PROTOCOL_SUPPORT = Object.freeze({
  latestStable: "2026-07-28",
  latestLegacy: LATEST_PROTOCOL_VERSION,
  supported: Object.freeze(["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS]),
  serverDiscovery: true,
  listCacheMetadata: false,
  durableTasks: false,
})
