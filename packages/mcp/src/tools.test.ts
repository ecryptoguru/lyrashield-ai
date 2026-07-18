import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  createScanTargetTool,
  createGetFindingsTool,
  createGetLaunchReadinessTool,
  createCreateReportTool,
  type ToolHandlerContext,
} from "./tools"

const mockFetch = vi.fn()

function makeApiResponse(data: unknown, success = true) {
  return {
    ok: true,
    status: 200,
    headers: { forEach: () => {} },
    json: async () => ({ success, data }),
  }
}

function makeErrorResponse(message: string) {
  return {
    ok: true,
    status: 400,
    headers: { forEach: () => {} },
    json: async () => ({ success: false, error: { code: "TEST_ERROR", message } }),
  }
}

const context: ToolHandlerContext = {
  apiBaseUrl: "http://localhost:3000",
  apiKey: "test-key",
  fetchFn: mockFetch as unknown as typeof fetch,
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe("createScanTargetTool", () => {
  it("triggers a scan via POST /api/scans", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponse({ id: "scan-1", status: "QUEUED" }))
    const tool = createScanTargetTool(context)
    const result = await tool.handler({ workspaceId: "ws-1", targetId: "t-1" })
    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0]!.text)
    expect(data.action).toBe("scan_triggered")
    expect(data.scan.id).toBe("scan-1")
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/scans",
      expect.objectContaining({ method: "POST" })
    )
    const request = mockFetch.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({ goal: "TEST_APP", mode: "SAFE" })
    const modeSchema = tool.inputSchema.properties.mode as { description: string }
    expect(modeSchema.description).toContain("STANDARD")
  })

  it("returns error on API failure", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse("Target not found"))
    const tool = createScanTargetTool(context)
    const result = await tool.handler({ workspaceId: "ws-1", targetId: "bad-id" })
    expect(result.isError).toBe(true)
    const data = JSON.parse(result.content[0]!.text)
    expect(data.error).toBe("Target not found")
  })
})

describe("createGetFindingsTool", () => {
  it("fetches findings with query params", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponse({ items: [], total: 0 }))
    const tool = createGetFindingsTool(context)
    const result = await tool.handler({ workspaceId: "ws-1", severity: "HIGH" })
    expect(result.isError).toBeUndefined()
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("workspaceId=ws-1"),
      expect.objectContaining({ method: "GET" })
    )
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("severity=HIGH"),
      expect.anything()
    )
  })
})

describe("createGetLaunchReadinessTool", () => {
  it("fetches launch readiness verdict", async () => {
    mockFetch.mockResolvedValueOnce(
      makeApiResponse({ verdict: "GO", score: 100, blockingFindings: 0 })
    )
    const tool = createGetLaunchReadinessTool(context)
    const result = await tool.handler({ workspaceId: "ws-1" })
    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0]!.text)
    expect(data.verdict).toBe("GO")
  })
})

describe("createCreateReportTool", () => {
  it("creates a report via POST /api/reports", async () => {
    mockFetch.mockResolvedValueOnce(makeApiResponse({ id: "r-1", title: "Test" }))
    const tool = createCreateReportTool(context)
    const result = await tool.handler({ workspaceId: "ws-1", title: "Test Report" })
    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0]!.text)
    expect(data.action).toBe("report_created")
    expect(data.report.id).toBe("r-1")
  })
})

describe("apiCall error handling", () => {
  it("handles non-OK HTTP status with non-JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: { forEach: () => {} },
      json: async () => {
        throw new Error("not JSON")
      },
    })
    const tool = createScanTargetTool(context)
    const result = await tool.handler({ workspaceId: "ws-1", targetId: "t-1" })
    expect(result.isError).toBe(true)
    const data = JSON.parse(result.content[0]!.text)
    expect(data.error).toContain("500")
  })

  it("handles non-OK HTTP status with JSON error body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: { forEach: () => {} },
      json: async () => ({ error: { message: "Permission denied" } }),
    })
    const tool = createScanTargetTool(context)
    const result = await tool.handler({ workspaceId: "ws-1", targetId: "t-1" })
    expect(result.isError).toBe(true)
    const data = JSON.parse(result.content[0]!.text)
    expect(data.error).toBe("Permission denied")
  })
})
