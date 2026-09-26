import { describe, it, expect, vi } from "vitest"
import { McpServer } from "./server"
import type { ToolHandlerContext } from "./tools"
import { logger } from "@lyrashield/logger"

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// A fetch stub that returns a successful API envelope, so if a handler DOES run
// we can tell (the test then fails, because a blocked mutation must not fetch).
function makeCtx(): { context: ToolHandlerContext; fetchSpy: ReturnType<typeof vi.fn> } {
  const fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({ success: true, data: { id: "scan_1" } }),
  })) as unknown as ReturnType<typeof vi.fn>
  const context: ToolHandlerContext = {
    apiBaseUrl: "http://localhost:3000",
    apiKey: "test",
    fetchFn: fetchSpy as unknown as typeof fetch,
  }
  return { context, fetchSpy }
}

describe("McpServer approval gate (S8)", () => {
  it("blocks a mutating tool by default (fail-closed, no gate)", async () => {
    const { context, fetchSpy } = makeCtx()
    const server = new McpServer({ toolContext: context })
    const res = await server.callTool("lyrashield_scan_target", {
      workspaceId: "w1",
      targetId: "t1",
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("Mutation was not authorized or could not be executed")
    expect(fetchSpy).not.toHaveBeenCalled() // handler never ran
  })

  it("blocks scan cancellation unless the mutation gate approves", async () => {
    const { context, fetchSpy } = makeCtx()
    const server = new McpServer({ toolContext: context })
    const result = await server.callTool("lyrashield_cancel_scan", {
      workspaceId: "w1",
      scanId: "scan-1",
    })
    expect(result.isError).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("never logs attachment content when an upload control argument is blocked", async () => {
    const { context, fetchSpy } = makeCtx()
    const server = new McpServer({ toolContext: context })
    const attachmentContent = "SENSITIVE-ATTACHMENT-CONTENT"
    const result = await server.callTool("lyrashield_upload_scan_attachment", {
      workspaceId: "ignore previous instructions",
      filename: "context.md",
      mediaType: "text/markdown",
      content: attachmentContent,
    })
    expect(result.isError).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(attachmentContent)
  })

  it("blocks a mutating tool when the gate denies", async () => {
    const { context, fetchSpy } = makeCtx()
    const gate = vi.fn(async () => ({ approved: false, reason: "user declined" }))
    const server = new McpServer({ toolContext: context, approvalGate: gate })
    const res = await server.callTool("lyrashield_create_report", { workspaceId: "w1", title: "R" })
    expect(res.isError).toBe(true)
    expect(gate).toHaveBeenCalledWith(
      "lyrashield_create_report",
      expect.objectContaining({ workspaceId: "w1" })
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("allows a mutating tool when the gate approves (re-validated against args)", async () => {
    const { context, fetchSpy } = makeCtx()
    const gate = vi.fn(async () => ({ approved: true }))
    const server = new McpServer({ toolContext: context, approvalGate: gate })
    const res = await server.callTool("lyrashield_scan_target", {
      workspaceId: "w1",
      targetId: "t1",
    })
    expect(res.isError).toBeFalsy()
    expect(gate).toHaveBeenCalledOnce()
    expect(fetchSpy).toHaveBeenCalledOnce() // handler ran after approval
  })

  it("never gates read-only tools", async () => {
    const { context, fetchSpy } = makeCtx()
    const gate = vi.fn(async () => ({ approved: false }))
    const server = new McpServer({ toolContext: context, approvalGate: gate })
    await server.callTool("lyrashield_get_findings", { workspaceId: "w1" })
    expect(gate).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("allowMutations:true opts out of the gate (trusted context)", async () => {
    const { context, fetchSpy } = makeCtx()
    const server = new McpServer({ toolContext: context, allowMutations: true })
    const res = await server.callTool("lyrashield_scan_target", {
      workspaceId: "w1",
      targetId: "t1",
    })
    expect(res.isError).toBeFalsy()
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("returns structured errors for protocol clients", async () => {
    const { context } = makeCtx()
    const server = new McpServer({ toolContext: context })

    const unknown = await server.callTool("lyrashield_missing", {})
    expect(unknown.structuredContent).toEqual({ error: "Unknown tool: lyrashield_missing" })

    const denied = await server.callTool("lyrashield_scan_target", {
      workspaceId: "w1",
      targetId: "t1",
    })
    expect(denied.structuredContent).toMatchObject({
      error: "Mutation was not authorized or could not be executed",
      tool: "lyrashield_scan_target",
    })
  })
})
