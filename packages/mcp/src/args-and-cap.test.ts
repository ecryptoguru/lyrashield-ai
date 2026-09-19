import { describe, it, expect, vi } from "vitest"
import { McpServer } from "./server"
import { MCP_RESULT_MAX_BYTES, MCP_TRUNCATION_MARKER } from "./result-cap"
import type { ToolHandlerContext } from "./tools"

function makeCtx(fetchImpl?: (input: unknown) => Promise<unknown>): {
  context: ToolHandlerContext
  fetchSpy: ReturnType<typeof vi.fn>
} {
  const fetchSpy = vi.fn(
    fetchImpl ??
      (async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: async () => ({ success: true, data: { id: "x" } }),
      }))
  )
  const context: ToolHandlerContext = {
    apiBaseUrl: "http://localhost:3000",
    apiKey: "test",
    fetchFn: fetchSpy as unknown as typeof fetch,
  }
  return { context, fetchSpy }
}

describe("MCP argument validation (v17)", () => {
  it("returns a structured validation error and never calls the handler", async () => {
    const { context, fetchSpy } = makeCtx()
    const server = new McpServer({ toolContext: context, allowMutations: true })
    // lyrashield_scan_target accepts workspaceId/targetId strings; a numeric
    // targetId violates the advertised inputSchema.
    const res = await server.callTool("lyrashield_scan_target", {
      workspaceId: "w1",
      targetId: 42,
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("Invalid tool arguments")
    expect(res.content[0]!.text).toContain("targetId")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("rejects a call missing a required argument", async () => {
    const { context, fetchSpy } = makeCtx()
    const server = new McpServer({ toolContext: context })
    const res = await server.callTool("lyrashield_get_findings", {})
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("Invalid tool arguments")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("still executes when arguments satisfy the schema", async () => {
    const { context, fetchSpy } = makeCtx()
    const server = new McpServer({ toolContext: context })
    const res = await server.callTool("lyrashield_get_findings", {
      workspaceId: "w1",
    })
    expect(res.isError).not.toBe(true)
    expect(fetchSpy).toHaveBeenCalled()
  })

  it("passes the injected control arguments through validation to the gate", async () => {
    const { context, fetchSpy } = makeCtx()
    const gate = vi.fn(async () => ({ approved: true }))
    const server = new McpServer({ toolContext: context, approvalGate: gate })
    // idempotencyKey and approvalId are injected into the advertised schema
    // for mutating tools; no tool sets additionalProperties:false, so they
    // must reach the approval gate unmodified rather than fail validation.
    const res = await server.callTool("lyrashield_scan_target", {
      workspaceId: "w1",
      targetId: "t1",
      idempotencyKey: "idem-123",
      approvalId: "approval-456",
    })
    expect(res.isError).not.toBe(true)
    expect(gate).toHaveBeenCalledWith(
      "lyrashield_scan_target",
      expect.objectContaining({ idempotencyKey: "idem-123", approvalId: "approval-456" })
    )
    expect(fetchSpy).toHaveBeenCalled()
  })
})

describe("MCP result cap (v17)", () => {
  it("truncates oversized structuredContent with an explicit marker", async () => {
    const big = "x".repeat(MCP_RESULT_MAX_BYTES * 2)
    const { context } = makeCtx(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ success: true, data: { blob: big } }),
    }))
    const server = new McpServer({ toolContext: context })
    const res = await server.callTool("lyrashield_get_findings", {
      workspaceId: "w1",
    })
    const sc = res.structuredContent as Record<string, unknown> | undefined
    expect(sc?.truncated).toBe(true)
    expect(sc?.marker).toBe(MCP_TRUNCATION_MARKER)
    expect(sc?.complete).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(res), "utf8")).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES)
  })

  it("bounds Unicode, escaping, and error results as a complete JSON object", async () => {
    const { capToolResult } = await import("./result-cap")
    const result = capToolResult({
      content: [
        { type: "text", text: '🛡️\\"'.repeat(150_000) },
        { type: "text", text: "extra".repeat(100_000) },
      ],
      structuredContent: { nextCursor: "page-2", scanId: "scan-1", data: "🛡️".repeat(150_000) },
      isError: true,
    })
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MCP_RESULT_MAX_BYTES
    )
    expect(result.structuredContent).toMatchObject({
      complete: false,
      nextCursor: "page-2",
      scanId: "scan-1",
    })
    expect(result.isError).toBe(true)
  })
})
