import { describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
  GetTaskResultSchema,
  ListTasksResultSchema,
  CancelTaskResultSchema,
  TaskSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { createLyraShieldServer } from "./create-server"
import type { ToolHandlerContext } from "./tools"
import type { McpTaskBackend } from "./task-adapter"

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const triggeredScanResult = {
  content: [{ type: "text" as const, text: '{"action":"scan_triggered"}' }],
  structuredContent: {
    action: "scan_triggered",
    scan: { id: "scan_1", status: "QUEUED", operationId: "rest_op_1" },
    operationId: "op_1",
  },
}

function fetchStub() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({ success: true, data: { id: "scan_1", status: "QUEUED" } }),
  })) as unknown as typeof fetch
}

function makeBackend(): McpTaskBackend & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    createTask: [],
    getTask: [],
    getTaskResult: [],
    cancelTask: [],
    listTasks: [],
  }
  return {
    calls,
    createTask: vi.fn(async (params: Record<string, unknown>) => {
      calls.createTask.push(params)
      return TaskSchema.parse({
        taskId: "lst_op_1",
        status: "working",
        ttl: 1000,
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        pollInterval: 10,
      })
    }),
    getTask: vi.fn(async (taskId: string) => {
      calls.getTask.push(taskId)
      return TaskSchema.parse({
        taskId,
        status: "working",
        ttl: 1000,
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      })
    }),
    getTaskResult: vi.fn(async () => triggeredScanResult),
    cancelTask: vi.fn(async (taskId: string) =>
      TaskSchema.parse({
        taskId,
        status: "cancelled",
        ttl: 1000,
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      })
    ),
    listTasks: vi.fn(async () => ({
      tasks: [
        TaskSchema.parse({
          taskId: "lst_op_1",
          status: "completed",
          ttl: 1000,
          createdAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
        }),
      ],
      nextCursor: undefined,
    })),
  }
}

async function connect(opts: { backend?: McpTaskBackend; fetchFn: typeof fetch }) {
  const context: ToolHandlerContext = {
    apiBaseUrl: "http://localhost:3000",
    apiKey: "lsk_test",
    fetchFn: opts.fetchFn,
    allowAutoDetect: false,
  }
  const { server } = createLyraShieldServer({
    allowMutations: true,
    toolContext: context,
    ...(opts.backend ? { tasks: { backend: opts.backend } } : {}),
  })
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe("task-augmented server wiring", () => {
  it("advertises the tasks capability and optional taskSupport only on the scan tool", async () => {
    const client = await connect({ backend: makeBackend(), fetchFn: fetchStub() })
    expect(client.getServerCapabilities()?.tasks).toEqual({
      requests: { tools: { call: {} } },
      list: {},
      cancel: {},
    })
    const { tools } = await client.listTools()
    const scanTool = tools.find((t) => t.name === "lyrashield_scan_target")!
    expect(scanTool.execution).toEqual({ taskSupport: "optional" })
    for (const t of tools.filter((x) => x.name !== "lyrashield_scan_target")) {
      expect(t.execution).toEqual({ taskSupport: "forbidden" })
    }
    await client.close()
  })

  it("creates a task through the backend for a task-augmented tools/call", async () => {
    const backend = makeBackend()
    const client = await connect({ backend, fetchFn: fetchStub() })
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "lyrashield_scan_target",
          arguments: { workspaceId: "ws_1", targetId: "t_1", idempotencyKey: "k1" },
          task: { ttl: 60000 },
        },
      },
      CreateTaskResultSchema
    )
    expect(result.task.taskId).toBe("lst_op_1")
    expect(result.task.status).toBe("working")
    const createArgs = backend.calls.createTask[0] as {
      toolName: string
      args: Record<string, unknown>
      taskParams: { ttl?: number }
      toolResult: { structuredContent?: { operationId?: string } }
    }
    expect(createArgs.toolName).toBe("lyrashield_scan_target")
    expect(createArgs.args).toMatchObject({ workspaceId: "ws_1", targetId: "t_1" })
    expect(createArgs.taskParams).toEqual({ ttl: 60000 })
    await client.close()
  })

  it("keeps the immediate result path for non-augmented calls", async () => {
    const backend = makeBackend()
    const fetchFn = fetchStub()
    const client = await connect({ backend, fetchFn })
    const result = await client.callTool({
      name: "lyrashield_scan_target",
      arguments: { workspaceId: "ws_1", targetId: "t_1" },
    })
    expect(result.isError).toBeFalsy()
    expect(backend.calls.createTask).toHaveLength(0)
    expect(fetchFn).toHaveBeenCalledOnce()
    await client.close()
  })

  it("rejects task augmentation on a non task-capable tool", async () => {
    const backend = makeBackend()
    const client = await connect({ backend, fetchFn: fetchStub() })
    await expect(
      client.request(
        {
          method: "tools/call",
          params: {
            name: "lyrashield_cancel_scan",
            arguments: { workspaceId: "ws_1", scanId: "s_1" },
            task: {},
          },
        },
        CreateTaskResultSchema
      )
    ).rejects.toThrow(/does not support task/i)
    expect(backend.calls.createTask).toHaveLength(0)
    await client.close()
  })

  it("rejects task augmentation when no backend is configured", async () => {
    const client = await connect({ fetchFn: fetchStub() })
    await expect(
      client.request(
        {
          method: "tools/call",
          params: {
            name: "lyrashield_scan_target",
            arguments: { workspaceId: "ws_1", targetId: "t_1" },
            task: {},
          },
        },
        CreateTaskResultSchema
      )
    ).rejects.toThrow()
    await client.close()
  })

  it("serves tasks/get, tasks/list, tasks/cancel and tasks/result through the backend", async () => {
    const backend = makeBackend()
    let taskCancelled = false
    const realGetTask = backend.getTask
    backend.getTask = vi.fn(async (taskId: string) => {
      const task = await realGetTask(taskId)
      return taskCancelled ? { ...task, status: "cancelled" as const } : task
    })
    const realCancel = backend.cancelTask
    backend.cancelTask = vi.fn(async (taskId: string) => {
      taskCancelled = true
      backend.calls.cancelTask.push(taskId)
      return realCancel(taskId)
    })
    const client = await connect({ backend, fetchFn: fetchStub() })
    const task = await client.request(
      { method: "tasks/get", params: { taskId: "lst_op_1" } },
      GetTaskResultSchema
    )
    expect(task.taskId).toBe("lst_op_1")
    expect(task.status).toBe("working")

    const list = await client.request({ method: "tasks/list", params: {} }, ListTasksResultSchema)
    expect(list.tasks).toHaveLength(1)

    const cancelled = await client.request(
      { method: "tasks/cancel", params: { taskId: "lst_op_1" } },
      CancelTaskResultSchema
    )
    expect(cancelled.status).toBe("cancelled")
    expect(backend.calls.cancelTask[0]).toBe("lst_op_1")

    const payload = await client.request(
      { method: "tasks/result", params: { taskId: "lst_op_done" } },
      CallToolResultSchema
    )
    expect(payload.structuredContent).toMatchObject({ action: "scan_triggered" })
    await client.close()
  })

  it("returns a bounded error when getTask resolves null", async () => {
    const backend = makeBackend()
    backend.getTask = vi.fn(async () => null)
    const client = await connect({ backend, fetchFn: fetchStub() })
    await expect(
      client.request(
        { method: "tasks/get", params: { taskId: "lst_foreign" } },
        GetTaskResultSchema
      )
    ).rejects.toThrow(/not found/i)
    await client.close()
  })

  it("tasks/result waits out a working task until terminal (bounded by pollInterval)", async () => {
    const backend = makeBackend()
    let polls = 0
    backend.getTask = vi.fn(async (taskId: string) => {
      polls += 1
      return TaskSchema.parse({
        taskId,
        status: polls > 2 ? "completed" : "working",
        ttl: 1000,
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        pollInterval: 5,
      })
    })
    const client = await connect({ backend, fetchFn: fetchStub() })
    const payload = await client.request(
      { method: "tasks/result", params: { taskId: "lst_op_1" } },
      CallToolResultSchema,
      { timeout: 10000 }
    )
    expect(payload.structuredContent).toMatchObject({ action: "scan_triggered" })
    expect(polls).toBeGreaterThan(2)
    await client.close()
  })
})
