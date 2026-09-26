import { describe, expect, it, vi } from "vitest"
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js"
import { handleRemoteMcpRequest } from "./http-transport"
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
  return (await readAllJson(res))[0] ?? {}
}

async function readAllJson(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text()
  // Stateless transport may answer as SSE events; unwrap every `data:` line so
  // batched responses are all visible.
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    return text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>)
  }
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t", version: "1" } },
}

describe("handleRemoteMcpRequest (Streamable HTTP, stateless)", () => {
  it("initializes and negotiates the protocol version", async () => {
    const res = await handleRemoteMcpRequest(mcpRequest(INIT), { toolContext: ctx(fetchStub()) })
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect((body.result as { protocolVersion?: string })?.protocolVersion).toBe(PROTOCOL)
  })

  it.each(SUPPORTED_PROTOCOL_VERSIONS)(
    "negotiates every SDK-supported protocol version via initialize: %s",
    async (protocolVersion) => {
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
  )

  it.each(["2026-07-28", "1999-01-01", "not-a-version", ""])(
    "initialize never echoes an unknown protocolVersion %p — answers with the SDK latest",
    async (requested) => {
      // MCP negotiation: an initialize for a version the SDK does not support is
      // answered with the newest version the server does support (the client is
      // then expected to disconnect if it cannot speak it). The server must
      // never claim the unknown version itself.
      const res = await handleRemoteMcpRequest(
        mcpRequest({
          ...INIT,
          params: { ...INIT.params, protocolVersion: requested },
        }),
        { toolContext: ctx(fetchStub()) }
      )
      expect(res.status).toBe(200)
      const body = await readJson(res)
      expect((body.result as { protocolVersion?: string })?.protocolVersion).toBe(
        LATEST_PROTOCOL_VERSION
      )
    }
  )

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

  it.each(["2026-07-28", "1999-01-01", "not-a-version", "1.0", "../etc/passwd"])(
    "rejects the unsupported MCP-Protocol-Version header %p with the SDK-supported list",
    async (protocolVersion) => {
      const res = await handleRemoteMcpRequest(
        mcpRequest({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }, protocolVersion),
        { toolContext: ctx(fetchStub()) }
      )
      const body = await readJson(res)

      expect(res.status).toBe(400)
      expect((body.error as { code?: number })?.code).toBe(-32000)
      expect((body.error as { message?: string })?.message).toContain(
        "Unsupported protocol version"
      )
      expect((body.error as { message?: string })?.message).toContain(LATEST_PROTOCOL_VERSION)
      for (const supported of SUPPORTED_PROTOCOL_VERSIONS) {
        expect((body.error as { message?: string })?.message).toContain(supported)
      }
    }
  )

  it.each([
    ["malformed JSON body", "{ not json", "application/json", 400, -32700],
    ["valid JSON but not a JSON-RPC message", '{"hello":"world"}', "application/json", 400, -32700],
    ["non-JSON content type", JSON.stringify(INIT), "text/plain", 415, -32000],
  ])(
    "fails closed on %s (HTTP %d, JSON-RPC %d)",
    async (_label, body, contentType, status, code) => {
      const res = await handleRemoteMcpRequest(
        new Request("https://app.example.com/api/mcp", {
          method: "POST",
          headers: {
            "Content-Type": contentType,
            Accept: "application/json, text/event-stream",
          },
          body,
        }),
        { toolContext: ctx(fetchStub()) }
      )
      expect(res.status).toBe(status)
      const parsed = JSON.parse(await res.text())
      expect(parsed.error?.code).toBe(code)
    }
  )

  it("fails closed when Accept does not include both required media types", async () => {
    const res = await handleRemoteMcpRequest(
      new Request("https://app.example.com/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(INIT),
      }),
      { toolContext: ctx(fetchStub()) }
    )
    expect(res.status).toBe(406)
    const parsed = JSON.parse(await res.text())
    expect(parsed.error?.code).toBe(-32000)
    expect(parsed.error?.message).toContain("text/event-stream")
  })

  it("rejects a request body over the SDK 4 MiB limit with 413", async () => {
    // Oversized Content-Length is refused without reading the stream (SDK 1.30.1).
    const res = await handleRemoteMcpRequest(
      new Request("https://app.example.com/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ pad: "x".repeat(4 * 1024 * 1024 + 1) }),
      }),
      { toolContext: ctx(fetchStub()) }
    )
    expect(res.status).toBe(413)
    const parsed = JSON.parse(await res.text())
    expect(parsed.error?.code).toBe(-32000)
    expect(parsed.error?.message).toContain("must not exceed")
  })

  it("supports JSON-RPC batching and bounds a batch at 100 messages", async () => {
    const list = { jsonrpc: "2.0", id: 21, method: "tools/list", params: {} }
    const ping = { jsonrpc: "2.0", id: 22, method: "ping" }

    const okRes = await handleRemoteMcpRequest(mcpRequest([list, ping]), {
      toolContext: ctx(fetchStub()),
    })
    expect(okRes.status).toBe(200)
    const answers = await readAllJson(okRes)
    expect(answers.map((m) => m.id).sort()).toEqual([21, 22])

    const tooBig = await handleRemoteMcpRequest(
      mcpRequest(Array.from({ length: 101 }, (_, i) => ({ ...ping, id: i }))),
      { toolContext: ctx(fetchStub()) }
    )
    expect(tooBig.status).toBe(400)
    const parsed = JSON.parse(await tooBig.text())
    expect(parsed.error?.code).toBe(-32600)
    expect(parsed.error?.message).toContain("must not exceed 100")
  })

  it("rejects a batch containing initialize plus other messages", async () => {
    const res = await handleRemoteMcpRequest(
      mcpRequest([INIT, { jsonrpc: "2.0", id: 30, method: "tools/list", params: {} }]),
      { toolContext: ctx(fetchStub()) }
    )
    expect(res.status).toBe(400)
    const parsed = JSON.parse(await res.text())
    expect(parsed.error?.code).toBe(-32600)
    expect(parsed.error?.message).toContain("Only one initialization request")
  })

  it.each([
    "server/discover",
    "resources/list",
    "prompts/list",
    "completion/complete",
    "tasks/get",
  ])("answers unsupported method %s with JSON-RPC Method not found", async (method) => {
    const res = await handleRemoteMcpRequest(
      mcpRequest({ jsonrpc: "2.0", id: 40, method, params: {} }),
      { toolContext: ctx(fetchStub()) }
    )
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect((body.error as { code?: number })?.code).toBe(-32601)
    expect((body.error as { message?: string })?.message).toContain("Method not found")
  })

  it("ignores session and replay routing headers — the transport is stateless", async () => {
    // No sessionIdGenerator: Mcp-Session-Id is neither issued nor required, and
    // with no event store Last-Event-ID is never honored. A caller claiming a
    // session must not get privileged or stale state.
    const request = mcpRequest({ jsonrpc: "2.0", id: 50, method: "tools/list", params: {} })
    request.headers.set("Mcp-Session-Id", "attacker-chosen-session")
    request.headers.set("Last-Event-ID", "999")
    const res = await handleRemoteMcpRequest(request, { toolContext: ctx(fetchStub()) })
    expect(res.status).toBe(200)
    expect(res.headers.get("mcp-session-id")).toBeNull()
    const body = await readJson(res)
    expect((body.result as { tools?: unknown[] })?.tools?.length).toBe(17)
  })

  it("rejects non-POST/GET/DELETE verbs with 405", async () => {
    const res = await handleRemoteMcpRequest(
      new Request("https://app.example.com/api/mcp", { method: "PUT" }),
      { toolContext: ctx(fetchStub()) }
    )
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toContain("POST")
  })

  it("lists all tools", async () => {
    const res = await handleRemoteMcpRequest(
      mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      { toolContext: ctx(fetchStub()) }
    )
    const body = await readJson(res)
    const tools = (body.result as { tools?: Array<{ name: string }> })?.tools ?? []
    expect(tools.length).toBe(21)
    expect(tools.map((t) => t.name)).toContain("lyrashield_run_pr_scan")
    expect(tools.map((t) => t.name)).toContain("lyrashield_get_scan_quality")
    expect(tools.map((t) => t.name)).toContain("lyrashield_get_scan_eligibility")
    expect(tools.map((t) => t.name)).toContain("lyrashield_upload_scan_attachment")
    expect(tools.map((t) => t.name)).toContain("lyrashield_request_fix_pr")
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
