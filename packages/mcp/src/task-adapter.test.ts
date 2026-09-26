import { describe, expect, it } from "vitest"
import {
  MCP_TASK_ID_PREFIX,
  MCP_TASK_TTL_MS,
  TASK_CAPABLE_TOOLS,
  assertTaskCapableTool,
  extractOperationIdFromToolResult,
  extractScanIdFromOperation,
  extractScanIdFromToolResult,
  isTaskMappingExpired,
  isTerminalTaskStatus,
  mapScanStatusToTaskStatus,
  operationMatchesPrincipal,
  parseTaskId,
  resolveTaskView,
  scanRowToCallToolResult,
  serializeTaskId,
  storedResultToCallToolResult,
  taskError,
  type TaskOperationRecord,
  type TaskScanRecord,
} from "./task-adapter"
import { MCP_RESULT_MAX_BYTES } from "./result-cap"

function makeOperation(overrides: Partial<TaskOperationRecord> = {}): TaskOperationRecord {
  return {
    id: "op_123",
    status: "COMPLETED",
    error: null,
    resultReference: "scan_123",
    result: null,
    workspaceId: "ws_1",
    principalType: "OAUTH_CONNECTION",
    principalId: "conn_1",
    connectionId: "conn_1",
    authorizationVersion: 3,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:05:00Z"),
    ...overrides,
  }
}

function makeScan(overrides: Partial<TaskScanRecord> = {}): TaskScanRecord {
  return {
    id: "scan_123",
    status: "COMPLETED",
    goal: "TEST_APP",
    mode: "STANDARD",
    triggerType: "manual",
    targetId: "t_1",
    startedAt: new Date("2026-01-01T00:01:00Z"),
    endedAt: new Date("2026-01-01T00:10:00Z"),
    durationMs: 540000,
    createdAt: new Date("2026-01-01T00:00:30Z"),
    updatedAt: new Date("2026-01-01T00:10:00Z"),
    summary: "done",
    errorCategory: null,
    errorMessage: null,
    target: {
      id: "t_1",
      name: "repo",
      type: "REPO",
      url: null,
      apiSpecUrl: null,
      repoFullName: "o/r",
    },
    ...overrides,
  }
}

describe("task id binding", () => {
  it("round-trips operation ids through task ids", () => {
    const taskId = serializeTaskId("op_abc123")
    expect(taskId).toBe(`${MCP_TASK_ID_PREFIX}op_abc123`)
    expect(parseTaskId(taskId)).toBe("op_abc123")
  })

  it("rejects malformed and foreign-shaped task ids", () => {
    expect(parseTaskId("")).toBeNull()
    expect(parseTaskId("scan_123")).toBeNull()
    expect(parseTaskId("lst_")).toBeNull()
    expect(parseTaskId(` ${MCP_TASK_ID_PREFIX}op`)).toBeNull()
    expect(parseTaskId("lst_" + "x".repeat(200))).toBeNull()
    expect(parseTaskId("lst_op with space")).toBeNull()
    expect(parseTaskId(null)).toBeNull()
    expect(parseTaskId(undefined)).toBeNull()
    expect(parseTaskId(42)).toBeNull()
  })

  it("rejects invalid operation ids when serializing", () => {
    expect(() => serializeTaskId("")).toThrow()
    expect(() => serializeTaskId("  ")).toThrow()
    expect(() => serializeTaskId("x".repeat(200))).toThrow()
  })
})

describe("mapScanStatusToTaskStatus", () => {
  it.each([
    ["QUEUED", "working"],
    ["PREFLIGHT", "working"],
    ["RUNNING", "working"],
    ["VERIFYING", "working"],
    ["REQUIRES_APPROVAL", "working"],
    ["COMPLETED", "completed"],
    ["PARTIAL", "completed"],
    ["FAILED", "failed"],
    ["STOPPED_BUDGET", "failed"],
    ["TIMED_OUT", "failed"],
    ["CANCELLED", "cancelled"],
  ] as const)("maps %s → %s", (scan, expected) => {
    expect(mapScanStatusToTaskStatus(scan)).toBe(expected)
  })

  it("maps unknown statuses to failed (fail-closed)", () => {
    expect(mapScanStatusToTaskStatus("SOMETHING_NEW")).toBe("failed")
  })

  it("exposes a terminal check matching the spec lifecycle", () => {
    expect(isTerminalTaskStatus("working")).toBe(false)
    expect(isTerminalTaskStatus("input_required")).toBe(false)
    expect(isTerminalTaskStatus("completed")).toBe(true)
    expect(isTerminalTaskStatus("failed")).toBe(true)
    expect(isTerminalTaskStatus("cancelled")).toBe(true)
  })
})

describe("resolveTaskView", () => {
  it("maps an in-flight operation to working", () => {
    const view = resolveTaskView({ operation: makeOperation({ status: "EXECUTING" }), scan: null })
    expect(view.status).toBe("working")
    const pending = resolveTaskView({ operation: makeOperation({ status: "PENDING" }), scan: null })
    expect(pending.status).toBe("working")
  })

  it("maps a failed or conflicting operation to failed", () => {
    expect(
      resolveTaskView({ operation: makeOperation({ status: "FAILED" }), scan: null }).status
    ).toBe("failed")
    expect(
      resolveTaskView({ operation: makeOperation({ status: "CONFLICT" }), scan: null }).status
    ).toBe("failed")
    const view = resolveTaskView({ operation: makeOperation({ status: "FAILED" }), scan: null })
    expect(view.statusMessage).toBeTruthy()
  })

  it("uses the scan status once the operation completed", () => {
    const running = resolveTaskView({
      operation: makeOperation(),
      scan: makeScan({ status: "RUNNING" }),
    })
    expect(running.status).toBe("working")
    const done = resolveTaskView({ operation: makeOperation(), scan: makeScan() })
    expect(done.status).toBe("completed")
    const cancelled = resolveTaskView({
      operation: makeOperation(),
      scan: makeScan({ status: "CANCELLED" }),
    })
    expect(cancelled.status).toBe("cancelled")
  })

  it("fails a completed operation whose recorded result is an error", () => {
    const op = makeOperation({
      resultReference: null,
      result: {
        content: [{ type: "text", text: '{"error":"denied"}' }],
        isError: true,
        structuredContent: { error: "denied" },
      },
    })
    const view = resolveTaskView({ operation: op, scan: null })
    expect(view.status).toBe("failed")
  })

  it("fails a completed operation when no scan binding can be resolved", () => {
    const op = makeOperation({
      resultReference: null,
      result: {
        content: [{ type: "text", text: "{}" }],
        structuredContent: { action: "scan_triggered" },
      },
    })
    // No scan row and no resolvable scanId — the mapping cannot produce work.
    expect(resolveTaskView({ operation: op, scan: null }).status).toBe("failed")
    // A recorded scanId but a missing/deleted scan row is also failed.
    expect(
      resolveTaskView({ operation: makeOperation({ resultReference: "scan_gone" }), scan: null })
        .status
    ).toBe("failed")
  })

  it("prefers the scan's updatedAt for lastUpdatedAt", () => {
    const scan = makeScan({ updatedAt: new Date("2026-01-02T00:00:00Z") })
    const view = resolveTaskView({ operation: makeOperation(), scan })
    expect(view.lastUpdatedAt).toBe(scan.updatedAt!.toISOString())
    const noScan = resolveTaskView({ operation: makeOperation(), scan: null })
    expect(noScan.lastUpdatedAt).toBe(makeOperation().updatedAt.toISOString())
  })
})

describe("extractScanIdFromOperation", () => {
  it("prefers resultReference", () => {
    const op = makeOperation({
      resultReference: "scan_ref",
      result: { structuredContent: { scan: { id: "scan_other" } } },
    })
    expect(extractScanIdFromOperation(op)).toBe("scan_ref")
  })

  it("falls back to the recorded tool result's scan id", () => {
    const op = makeOperation({
      resultReference: null,
      result: { structuredContent: { scan: { id: "scan_inner" } } },
    })
    expect(extractScanIdFromOperation(op)).toBe("scan_inner")
  })

  it("returns null when nothing is recorded", () => {
    expect(extractScanIdFromOperation(makeOperation({ resultReference: null }))).toBeNull()
    expect(
      extractScanIdFromOperation(makeOperation({ resultReference: null, result: "junk" }))
    ).toBeNull()
  })
})

describe("tool-result extraction helpers", () => {
  it("extracts the stamped operation id", () => {
    expect(
      extractOperationIdFromToolResult({
        content: [],
        structuredContent: { action: "scan_triggered", operationId: "op_1" },
      })
    ).toBe("op_1")
    expect(extractOperationIdFromToolResult({ content: [] })).toBeNull()
    expect(
      extractOperationIdFromToolResult({ content: [], structuredContent: { operationId: 42 } })
    ).toBeNull()
  })

  it("extracts the scan id from a triggered result", () => {
    expect(
      extractScanIdFromToolResult({
        content: [],
        structuredContent: { scan: { id: "scan_9" } },
      })
    ).toBe("scan_9")
    expect(extractScanIdFromToolResult({ content: [] })).toBeNull()
  })
})

describe("operationMatchesPrincipal", () => {
  const principal = { principalType: "OAUTH_CONNECTION", principalId: "conn_1" }

  it("accepts a matching principal and authorization version", () => {
    expect(
      operationMatchesPrincipal(makeOperation(), { ...principal, authorizationVersion: 3 })
    ).toBe(true)
  })

  it("rejects a foreign principal (wrong owner)", () => {
    expect(
      operationMatchesPrincipal(makeOperation({ principalId: "conn_other" }), {
        ...principal,
        authorizationVersion: 3,
      })
    ).toBe(false)
    expect(
      operationMatchesPrincipal(makeOperation({ principalType: "API_KEY" }), {
        ...principal,
        authorizationVersion: 3,
      })
    ).toBe(false)
  })

  it("rejects a stale authorization version (grant re-scoped since binding)", () => {
    expect(
      operationMatchesPrincipal(makeOperation({ authorizationVersion: 3 }), {
        ...principal,
        authorizationVersion: 4,
      })
    ).toBe(false)
  })
})

describe("scanRowToCallToolResult", () => {
  it("constructs a bounded completed result only from persisted fields", () => {
    const scan = makeScan()
    const result = scanRowToCallToolResult({ scan })
    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent!
    expect(sc.action).toBe("scan_completed")
    const scanView = sc.scan as Record<string, unknown>
    expect(scanView.id).toBe("scan_123")
    expect(scanView.status).toBe("COMPLETED")
    // Allowlisted fields only — no cost or credential columns.
    expect(scanView).not.toHaveProperty("providerCostUsd")
    expect(scanView).not.toHaveProperty("billedCostUsd")
    expect(scanView).not.toHaveProperty("actualCostCents")
    expect(scanView).not.toHaveProperty("executionPlan")
    expect(scanView).not.toHaveProperty("sarifUri")
    expect(scanView).not.toHaveProperty("createdById")
    expect(scanView).not.toHaveProperty("sponsorAccountId")
    // Content text mirrors the structured payload.
    expect(result.content[0].type).toBe("text")
    expect(JSON.parse(result.content[0].text)).toMatchObject({ action: "scan_completed" })
  })

  it("marks failed and cancelled terminal states as errors", () => {
    const failed = scanRowToCallToolResult({ scan: makeScan({ status: "FAILED" }) })
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent?.action).toBe("scan_failed")
    const cancelled = scanRowToCallToolResult({ scan: makeScan({ status: "CANCELLED" }) })
    expect(cancelled.isError).toBe(true)
    expect(cancelled.structuredContent?.action).toBe("scan_cancelled")
  })

  it("bounds oversized results under the 256 KiB cap", () => {
    const scan = makeScan({ summary: "x".repeat(MCP_RESULT_MAX_BYTES * 2) })
    const result = scanRowToCallToolResult({ scan })
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8")
    expect(bytes).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES)
    expect(result.structuredContent?.truncated).toBe(true)
    expect(result.structuredContent?.scanId).toBe("scan_123")
  })
})

describe("storedResultToCallToolResult", () => {
  it("replays a recorded tool result shape", () => {
    const stored = {
      content: [{ type: "text", text: '{"error":"denied"}' }],
      isError: true,
      structuredContent: { error: "denied" },
    }
    const result = storedResultToCallToolResult(stored)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({ error: "denied" })
  })

  it("rejects malformed stored results", () => {
    expect(() => storedResultToCallToolResult(null)).toThrow()
    expect(() => storedResultToCallToolResult({ content: "nope" })).toThrow()
    expect(() => storedResultToCallToolResult({ content: [{ type: "text" }] })).toThrow()
  })
})

describe("task capable tools", () => {
  it("only the recorded scan tool is task capable", () => {
    expect(TASK_CAPABLE_TOOLS.has("lyrashield_scan_target")).toBe(true)
    expect(TASK_CAPABLE_TOOLS.has("lyrashield_cancel_scan")).toBe(false)
    expect(TASK_CAPABLE_TOOLS.has("lyrashield_get_scan_status")).toBe(false)
    expect(TASK_CAPABLE_TOOLS.has("lyrashield_run_pr_scan")).toBe(false)
  })

  it("assertTaskCapableTool rejects unsupported tools with a bounded error", () => {
    expect(() => assertTaskCapableTool("lyrashield_scan_target")).not.toThrow()
    const err = taskError(() => assertTaskCapableTool("lyrashield_cancel_scan"))
    expect(err).toMatch(/does not support task/i)
    expect(taskError(() => assertTaskCapableTool("bogus"))).toMatch(/does not support task/i)
  })
})

describe("task expiry", () => {
  it("expires mappings after the policy TTL", () => {
    const created = new Date("2026-01-01T00:00:00Z")
    const inside = new Date(created.getTime() + MCP_TASK_TTL_MS - 1)
    const outside = new Date(created.getTime() + MCP_TASK_TTL_MS)
    expect(isTaskMappingExpired(created, inside)).toBe(false)
    expect(isTaskMappingExpired(created, outside)).toBe(true)
  })
})
