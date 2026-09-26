import { describe, expect, it, vi } from "vitest"
import { McpError } from "@modelcontextprotocol/sdk/types.js"
import { createLocalTaskBackend } from "./local-task-backend"
import { serializeTaskId } from "./task-adapter"
import type { ToolHandlerContext } from "./tools"
import type { McpToolResult } from "./tools"

function restFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    const pathname = u.pathname.replace(/^\/api\/v1/, "/api")
    const key = `${init?.method ?? "GET"} ${pathname}${u.search}`
    const alt = `${init?.method ?? "GET"} ${pathname}`
    const payload =
      routes[key] ?? routes[alt] ?? routes[`${pathname}${u.search}`] ?? routes[pathname]
    if (payload === undefined) {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Headers(),
        json: async () => ({ success: false, error: { code: "NOT_FOUND", message: "nf" } }),
        text: async () => "",
        body: null,
      }
    }
    const result = typeof payload === "function" ? payload(init) : payload
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ success: true, data: result }),
      text: async () => JSON.stringify({ success: true, data: result }),
      body: null,
    }
  }) as unknown as typeof fetch
}

function context(fetchFn: typeof fetch): ToolHandlerContext {
  return { apiBaseUrl: "http://localhost:3000", apiKey: "lsk_test", fetchFn }
}

const triggered = (over: Record<string, unknown> = {}): McpToolResult => ({
  content: [{ type: "text", text: "{}" }],
  structuredContent: {
    action: "scan_triggered",
    scan: { id: "scan_1", status: "QUEUED", operationId: "rest_op_1", ...over },
  },
})

describe("createLocalTaskBackend", () => {
  it("creates a task bound to the recorded REST operation", async () => {
    const backend = createLocalTaskBackend(context(restFetch({})))
    const task = await backend.createTask({
      toolName: "lyrashield_scan_target",
      args: { workspaceId: "ws_1", targetId: "t_1" },
      taskParams: {},
      toolResult: triggered(),
    })
    expect(task.taskId).toBe(serializeTaskId("rest_op_1"))
    expect(task.status).toBe("working")
  })

  it("refuses to create a task from an error tool result (no durable work)", async () => {
    const backend = createLocalTaskBackend(context(restFetch({})))
    await expect(
      backend.createTask({
        toolName: "lyrashield_scan_target",
        args: { workspaceId: "ws_1" },
        taskParams: {},
        toolResult: {
          content: [{ type: "text", text: '{"error":"denied"}' }],
          isError: true,
          structuredContent: { error: "denied" },
        },
      })
    ).rejects.toThrow(McpError)
  })

  it("resolves task status from the durable scan row (session cache)", async () => {
    const fetchFn = restFetch({
      "/api/scans/scan_1": { id: "scan_1", status: "RUNNING" },
    })
    const backend = createLocalTaskBackend(context(fetchFn))
    const task = await backend.createTask({
      toolName: "lyrashield_scan_target",
      args: { workspaceId: "ws_1" },
      taskParams: {},
      toolResult: triggered(),
    })
    const view = await backend.getTask(task.taskId)
    expect(view?.status).toBe("working")
  })

  it("recovers a task after session-cache loss via the durable operation record", async () => {
    const opId = "rest_op_1"
    const now = Date.now()
    const fetchFn = restFetch({
      "/api/workspaces": [{ id: "ws_1", name: "ws" }],
      "/api/agent-operations/rest_op_1": {
        operationId: opId,
        status: "COMPLETED",
        reasonCode: null,
        resultLocation: "scan_1",
        recovery: "none",
        createdAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 30_000).toISOString(),
      },
      "/api/scans/scan_1": { id: "scan_1", status: "RUNNING" },
    })
    const backend = createLocalTaskBackend(context(fetchFn))
    // Simulate process replacement: the taskId is all that survived.
    const view = await backend.getTask(serializeTaskId(opId))
    expect(view?.status).toBe("working")
  })

  it("returns null for malformed or unknown task ids", async () => {
    const backend = createLocalTaskBackend(context(restFetch({})))
    expect(await backend.getTask("not-a-task")).toBeNull()
    expect(await backend.getTask(serializeTaskId("op_unknown"))).toBeNull()
  })

  it("constructs results only from persisted scan state for terminal tasks", async () => {
    const fetchFn = restFetch({
      "/api/scans/scan_1": {
        id: "scan_1",
        status: "COMPLETED",
        goal: "TEST_APP",
        mode: "STANDARD",
        endedAt: "2026-01-01T00:10:00.000Z",
      },
    })
    const backend = createLocalTaskBackend(context(fetchFn))
    const task = await backend.createTask({
      toolName: "lyrashield_scan_target",
      args: { workspaceId: "ws_1" },
      taskParams: {},
      toolResult: triggered(),
    })
    const result = await backend.getTaskResult(task.taskId)
    expect(result.structuredContent).toMatchObject({
      action: "scan_completed",
      scan: { id: "scan_1", status: "COMPLETED" },
    })
  })

  it("routes cancellation through the REST scan-cancel path", async () => {
    let posted: Record<string, unknown> | undefined
    const fetchFn = restFetch({
      "/api/scans/scan_1": { id: "scan_1", status: "RUNNING" },
      "POST /api/scans/scan_1": (init: RequestInit) => {
        posted = JSON.parse(String(init.body))
        return { id: "scan_1", status: "CANCELLED", endedAt: null }
      },
    })
    const backend = createLocalTaskBackend(context(fetchFn))
    const task = await backend.createTask({
      toolName: "lyrashield_scan_target",
      args: { workspaceId: "ws_1" },
      taskParams: {},
      toolResult: triggered(),
    })
    const cancelled = await backend.cancelTask(task.taskId)
    expect(cancelled?.status).toBe("cancelled")
    expect(posted).toMatchObject({ workspaceId: "ws_1" })
  })

  it("lists only the tasks this process created (bounded, session-lifetime)", async () => {
    const backend = createLocalTaskBackend(context(restFetch({})))
    const task = await backend.createTask({
      toolName: "lyrashield_scan_target",
      args: { workspaceId: "ws_1" },
      taskParams: {},
      toolResult: triggered(),
    })
    const { tasks } = await backend.listTasks()
    expect(tasks.map((t) => t.taskId)).toEqual([task.taskId])
  })
})
