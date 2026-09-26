import { describe, expect, it, vi } from "vitest"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server"
import { handleRemoteMcpRequest } from "./http-transport"
import { createAllTools } from "./tools"
import type { ToolHandlerContext } from "./tools"

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const PROTOCOL = "2025-06-18"

function fetchStub(data: unknown = { ok: true }) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({ success: true, data }),
  })) as unknown as typeof fetch
}

function ctx(fetchFn: typeof fetch): ToolHandlerContext {
  return { apiBaseUrl: "https://app.example.com", apiKey: "lsk_test", fetchFn }
}

function mcpRequest(body: unknown, protocolVersion?: string): Request {
  return new Request("https://app.example.com/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The Streamable HTTP spec requires the client to accept both.
      Accept: "application/json, text/event-stream",
      ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  // Stateless transport may answer as a single SSE event; unwrap `data:` lines.
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"))
    return line ? JSON.parse(line.slice(5).trim()) : {}
  }
  return JSON.parse(text)
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t", version: "1" } },
}

describe("handleRemoteMcpRequest (Streamable HTTP, stateless)", () => {
  it("rejects an oversized hosted request before SDK parsing or tool execution", async () => {
    const fetchFn = fetchStub()
    const request = new Request("https://app.example.com/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "x".repeat(13 * 1024 * 1024 + 1),
    })
    const response = await handleRemoteMcpRequest(request, { toolContext: ctx(fetchFn) })
    expect(response.status).toBe(413)
    expect((await response.json()).error.message).toBe("MCP request body too large")
    expect(fetchFn).not.toHaveBeenCalled()
  }, 20_000)
  it("initializes and negotiates the protocol version", async () => {
    const res = await handleRemoteMcpRequest(mcpRequest(INIT), { toolContext: ctx(fetchStub()) })
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect((body.result as { protocolVersion?: string })?.protocolVersion).toBe(PROTOCOL)
  })

  it("negotiates the SDK latest stable protocol while preserving the previous client", async () => {
    for (const protocolVersion of [LATEST_PROTOCOL_VERSION, PROTOCOL]) {
      const res = await handleRemoteMcpRequest(
        mcpRequest({
          ...INIT,
          params: { ...INIT.params, protocolVersion },
        }),
        { toolContext: ctx(fetchStub()) }
      )
      expect(res.status).toBe(200)
      const body = await readJson(res)
      expect((body.result as { protocolVersion?: string })?.protocolVersion).toBe(protocolVersion)
    }
  })

  it("marks authenticated MCP responses as non-cacheable", async () => {
    const res = await handleRemoteMcpRequest(mcpRequest(INIT), {
      toolContext: ctx(fetchStub()),
    })

    expect(res.headers.get("cache-control")).toContain("no-store")
    expect(res.headers.get("cache-control")).toContain("no-transform")
    expect(res.headers.get("vary")).toContain("Accept")
    expect(res.headers.get("vary")).toContain("Authorization")
    expect(res.headers.get("vary")).toContain("MCP-Protocol-Version")
  })

  it("rejects unsupported protocol headers with the SDK-supported versions", async () => {
    const res = await handleRemoteMcpRequest(
      mcpRequest({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }, "2024-01-01"),
      { toolContext: ctx(fetchStub()) }
    )
    const body = await readJson(res)

    expect(res.status).toBe(400)
    expect((body.error as { message?: string })?.message).toContain("Unsupported protocol version")
    expect((body.error as { message?: string })?.message).toContain(LATEST_PROTOCOL_VERSION)
  })

  it("serves the 2026-07-28 discovery and tool exchange through the official client", async () => {
    const fetchFn = fetchStub([{ id: "ws-1" }])
    let modernCall: Request | undefined
    const client = new Client(
      { name: "protocol-test", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    )
    const transport = new StreamableHTTPClientTransport(
      new URL("https://app.example.com/api/mcp"),
      {
        fetch: (url, init) => {
          const request = new Request(url, init)
          if (request.headers.get("MCP-Method") === "tools/call") modernCall = request.clone()
          return handleRemoteMcpRequest(request, { toolContext: ctx(fetchFn) })
        },
      }
    )
    try {
      await client.connect(transport)
      expect(client.getProtocolEra()).toBe("modern")
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name)).toContain("lyrashield_list_workspaces")
      const result = await client.callTool({ name: "lyrashield_list_workspaces", arguments: {} })
      expect(result.isError).toBeFalsy()
      expect(fetchFn).toHaveBeenCalledOnce()
      const denied = await client.callTool({
        name: "lyrashield_run_pr_scan",
        arguments: { workspaceId: "ws-1", targetId: "t-1" },
      })
      expect(denied.isError).toBe(true)
      expect(fetchFn).toHaveBeenCalledOnce()
      expect(modernCall).toBeDefined()
      const mismatched = modernCall!.clone()
      mismatched.headers.set("MCP-Method", "tools/list")
      const rejection = await handleRemoteMcpRequest(mismatched, { toolContext: ctx(fetchFn) })
      expect(rejection.status).toBe(400)
      expect(fetchFn).toHaveBeenCalledOnce()
    } finally {
      await client.close()
    }
  })

  it("lists all tools", async () => {
    const res = await handleRemoteMcpRequest(
      mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      { toolContext: ctx(fetchStub()) }
    )
    const body = await readJson(res)
    const tools = (body.result as { tools?: Array<{ name: string }> })?.tools ?? []
    expect(tools.length).toBe(createAllTools(ctx(fetchStub())).length)
    expect(tools.map((t) => t.name)).toContain("lyrashield_run_pr_scan")
    expect(tools.map((t) => t.name)).toContain("lyrashield_get_scan_quality")
  })

  it("runs a read-only tool", async () => {
    const fetchFn = fetchStub([{ id: "ws-1" }])
    const res = await handleRemoteMcpRequest(
      mcpRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "lyrashield_list_workspaces", arguments: {} },
      }),
      { toolContext: ctx(fetchFn) }
    )
    const body = await readJson(res)
    expect((body.result as { isError?: boolean })?.isError).toBeFalsy()
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it("refuses a mutating tool by default (no remote approval channel)", async () => {
    const fetchFn = fetchStub()
    const res = await handleRemoteMcpRequest(
      mcpRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "lyrashield_run_pr_scan",
          arguments: { workspaceId: "ws-1", targetId: "t-1" },
        },
      }),
      { toolContext: ctx(fetchFn) }
    )
    const body = await readJson(res)
    const result = body.result as { isError?: boolean; content?: Array<{ text: string }> }
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0]?.text).toContain("no interactive approval channel")
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("allows a mutating tool when allowMutations is set (trusted automation)", async () => {
    const fetchFn = fetchStub({ id: "scan-1" })
    const res = await handleRemoteMcpRequest(
      mcpRequest({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "lyrashield_run_pr_scan",
          arguments: { workspaceId: "ws-1", targetId: "t-1" },
        },
      }),
      { toolContext: ctx(fetchFn), allowMutations: true }
    )
    const body = await readJson(res)
    expect((body.result as { isError?: boolean })?.isError).toBeFalsy()
    expect(fetchFn).toHaveBeenCalledOnce()
  })
})
