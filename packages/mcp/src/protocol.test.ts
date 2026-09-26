import { describe, expect, it } from "vitest"
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server"
import { MCP_PROTOCOL_SUPPORT } from "./protocol"

describe("MCP_PROTOCOL_SUPPORT", () => {
  it("derives protocol support from the installed SDK", () => {
    expect(MCP_PROTOCOL_SUPPORT.latestStable).toBe("2026-07-28")
    expect(MCP_PROTOCOL_SUPPORT.latestLegacy).toBe(LATEST_PROTOCOL_VERSION)
    expect(MCP_PROTOCOL_SUPPORT.supported).toEqual(["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS])
  })

  it("advertises discovery but not unimplemented caching or durable tasks", () => {
    expect(MCP_PROTOCOL_SUPPORT.serverDiscovery).toBe(true)
    expect(MCP_PROTOCOL_SUPPORT.listCacheMetadata).toBe(false)
    expect(MCP_PROTOCOL_SUPPORT.durableTasks).toBe(false)
  })
})
