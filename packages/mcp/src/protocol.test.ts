import { describe, expect, it } from "vitest"
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js"
import { MCP_PROTOCOL_SUPPORT } from "./protocol"

describe("MCP_PROTOCOL_SUPPORT", () => {
  it("derives protocol support from the installed SDK", () => {
    expect(MCP_PROTOCOL_SUPPORT.latestStable).toBe(LATEST_PROTOCOL_VERSION)
    expect(MCP_PROTOCOL_SUPPORT.supported).toEqual(SUPPORTED_PROTOCOL_VERSIONS)
  })

  it("does not advertise SDK-unsupported discovery, list caching, or durable tasks", () => {
    expect(MCP_PROTOCOL_SUPPORT.serverDiscovery).toBe(false)
    expect(MCP_PROTOCOL_SUPPORT.listCacheMetadata).toBe(false)
    expect(MCP_PROTOCOL_SUPPORT.durableTasks).toBe(false)
  })
})
