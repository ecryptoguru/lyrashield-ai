import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  createScanTargetTool,
  createGetFindingsTool,
  createGetLaunchReadinessTool,
  createCreateReportTool,
  createPrSecurityRecapTool,
  type ToolHandlerContext,
  MCP_TOOL_ANNOTATIONS,
} from "./tools"

const mockFetch = vi.fn()

function makeApiResponse(data: unknown, success = true) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ success, data }),
  }
}

function makeErrorResponse(message: string) {
  return {
    ok: true,
    status: 400,
    headers: new Headers(),
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

describe("MCP safety metadata", () => {
  it("annotates every published tool explicitly", async () => {
    const { createAllTools } = await import("./tools")
    const tools = createAllTools(context)
    expect(tools).toHaveLength(Object.keys(MCP_TOOL_ANNOTATIONS).length)
    for (const tool of tools) {
      expect(MCP_TOOL_ANNOTATIONS[tool.name]).toBeDefined()
      expect(typeof MCP_TOOL_ANNOTATIONS[tool.name]?.readOnlyHint).toBe("boolean")
      expect(typeof MCP_TOOL_ANNOTATIONS[tool.name]?.destructiveHint).toBe("boolean")
      expect(typeof MCP_TOOL_ANNOTATIONS[tool.name]?.openWorldHint).toBe("boolean")
    }
  })
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
      "http://localhost:3000/api/v1/scans",
      expect.objectContaining({ method: "POST" })
    )
    const request = mockFetch.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({ goal: "TEST_APP", mode: "STANDARD" })
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

  it("resolves a repo argument to a target and creates it when missing", async () => {
    mockFetch
      .mockResolvedValueOnce(makeApiResponse({ items: [] }))
      .mockResolvedValueOnce(makeApiResponse({ id: "t-123", name: "lyrashield-ai" }))
      .mockResolvedValueOnce(makeApiResponse({ id: "scan-1", status: "QUEUED" }))
    const tool = createScanTargetTool(context)
    const result = await tool.handler({ workspaceId: "ws-1", repo: "ecryptoguru/lyrashield-ai" })
    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0]!.text)
    expect(data.action).toBe("scan_triggered")
    expect(data.repository).toBe("ecryptoguru/lyrashield-ai")
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/v1/targets",
      expect.objectContaining({ method: "POST" })
    )
    const createCall = mockFetch.mock.calls[1]![1] as RequestInit
    expect(JSON.parse(String(createCall.body))).toMatchObject({
      workspaceId: "ws-1",
      name: "lyrashield-ai",
      type: "REPO",
      repoProvider: "github",
      repoOwner: "ecryptoguru",
      repoName: "lyrashield-ai",
    })
  })

  it("reuses an existing repo target when the target list omits repoProvider", async () => {
    mockFetch
      .mockResolvedValueOnce(
        makeApiResponse({
          items: [{ id: "t-existing", repoFullName: "ecryptoguru/lyrashield-ai" }],
        })
      )
      .mockResolvedValueOnce(makeApiResponse({ id: "scan-1", status: "QUEUED" }))
    const tool = createScanTargetTool(context)

    const result = await tool.handler({ workspaceId: "ws-1", repo: "ecryptoguru/lyrashield-ai" })

    expect(result.isError).toBeUndefined()
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const scanRequest = mockFetch.mock.calls[1]![1] as RequestInit
    expect(JSON.parse(String(scanRequest.body))).toMatchObject({ targetId: "t-existing" })
  })

  it("rejects auto-detection on the hosted transport", async () => {
    const remoteTool = createScanTargetTool({ ...context, allowAutoDetect: false })

    const result = await remoteTool.handler({ workspaceId: "ws-1", auto: true })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain("local stdio MCP server")
    expect(mockFetch).not.toHaveBeenCalled()
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

describe("createPrSecurityRecapTool", () => {
  it("paginates all open findings and labels the result as a current-state snapshot", async () => {
    mockFetch
      .mockResolvedValueOnce(makeApiResponse({ verdict: "HOLD" }))
      .mockResolvedValueOnce(
        makeApiResponse({
          items: [{ id: "f-1", severity: "HIGH", status: "OPEN" }],
          nextCursor: "f-1",
        })
      )
      .mockResolvedValueOnce(
        makeApiResponse({
          items: [{ id: "f-2", severity: "MEDIUM", status: "OPEN" }],
          nextCursor: null,
        })
      )

    const tool = createPrSecurityRecapTool(context)
    const result = await tool.handler({ workspaceId: "ws-1", targetId: "target-1" })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0]!.text)
    expect(data.findingCount).toBe(2)
    expect(data.bySeverity).toEqual({ HIGH: 1, MEDIUM: 1 })
    expect(data.markdown).toContain("**Open findings by severity:**")
    expect(data.markdown).toContain("current workspace/target snapshot")
    expect(data.markdown).not.toContain("latest completed scan")

    const firstFindingsUrl = String(mockFetch.mock.calls[1]![0])
    const secondFindingsUrl = String(mockFetch.mock.calls[2]![0])
    expect(firstFindingsUrl).toContain("targetId=target-1")
    expect(firstFindingsUrl).toContain("status=OPEN")
    expect(firstFindingsUrl).toContain("limit=100")
    expect(firstFindingsUrl).not.toContain("cursor=")
    expect(secondFindingsUrl).toContain("cursor=f-1")
  })
})

describe("apiCall error handling", () => {
  it("handles non-OK HTTP status with non-JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers(),
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
      headers: new Headers(),
      json: async () => ({ error: { message: "Permission denied" } }),
    })
    const tool = createScanTargetTool(context)
    const result = await tool.handler({ workspaceId: "ws-1", targetId: "t-1" })
    expect(result.isError).toBe(true)
    const data = JSON.parse(result.content[0]!.text)
    expect(data.error).toBe("Permission denied")
  })
})
