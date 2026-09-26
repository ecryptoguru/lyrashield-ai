import { z } from "zod"
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Task,
} from "@modelcontextprotocol/sdk/types.js"
import { LyraShieldClient, OperationStatusSchema } from "@lyrashield/sdk"
import type { ToolHandlerContext } from "./tools"
import {
  assertTaskCapableTool,
  buildTask,
  extractScanIdFromToolResult,
  isTaskMappingExpired,
  isTerminalTaskStatus,
  mapScanStatusToTaskStatus,
  parseTaskId,
  scanRowToCallToolResult,
  serializeTaskId,
  type McpTaskBackend,
  type TaskScanRecord,
} from "./task-adapter"

/**
 * Local (stdio) task backend.
 *
 * Task state still lives in the durable AgentOperation + Scan ledger — this
 * backend resolves it through the same REST surface the tools use, so a
 * `lst_<operationId>` task survives even a local process restart whenever the
 * credential still resolves the operation. The in-memory map is only a
 * session cache for fast polls and for listTasks (the ledger exposes no
 * principal-scoped REST listing): tasks created by a different process stay
 * resolvable by id but never appear in a local tasks/list. That asymmetry is
 * the documented stdio limitation; durability itself is delegated to the
 * server-side ledger, not to process memory.
 */

interface LocalTaskEntry {
  taskId: string
  operationId: string | null
  scanId: string | null
  workspaceId: string
  createdAtMs: number
}

const workspacesSchema = z.array(z.object({ id: z.string() })).max(50)

const restScanSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  goal: z.string().nullish(),
  mode: z.string().nullish(),
  triggerType: z.string().nullish(),
  targetId: z.string().nullish(),
  startedAt: z.string().nullish(),
  endedAt: z.string().nullish(),
  durationMs: z.number().nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  summary: z.string().nullish(),
  errorCategory: z.string().nullish(),
  errorMessage: z.string().nullish(),
  target: z
    .object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      url: z.string().nullish(),
      apiSpecUrl: z.string().nullish(),
      repoFullName: z.string().nullish(),
    })
    .nullish(),
})

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function createLocalTaskBackend(context: ToolHandlerContext): McpTaskBackend {
  const entries = new Map<string, LocalTaskEntry>()
  let workspaceIdPromise: Promise<string | null> | null = null

  function client(): LyraShieldClient {
    return new LyraShieldClient({
      apiKey: context.apiKey,
      apiUrl: context.apiBaseUrl,
      fetchFn: context.fetchFn,
      getAccessToken: context.getCredentials
        ? async () => (await context.getCredentials!()).apiKey
        : undefined,
    })
  }

  async function resolveWorkspaceId(): Promise<string | null> {
    workspaceIdPromise ??= (async () => {
      try {
        const data = await client().request("GET", "/workspaces")
        const parsed = workspacesSchema.safeParse(data)
        // A workspace API key resolves exactly one workspace; anything else is
        // ambiguous and must not guess.
        return parsed.success && parsed.data.length === 1 ? parsed.data[0]!.id : null
      } catch {
        return null
      }
    })()
    return workspaceIdPromise
  }

  async function fetchOperationStatus(
    operationId: string,
    workspaceId: string
  ): Promise<z.infer<typeof OperationStatusSchema> | null> {
    try {
      const data = await client().request(
        "GET",
        `/agent-operations/${encodeURIComponent(operationId)}?${new URLSearchParams({ workspaceId })}`
      )
      const parsed = OperationStatusSchema.safeParse(data)
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  async function fetchScan(scanId: string, workspaceId: string): Promise<TaskScanRecord | null> {
    try {
      const data = await client().request(
        "GET",
        `/scans/${encodeURIComponent(scanId)}?${new URLSearchParams({ workspaceId })}`
      )
      const parsed = restScanSchema.safeParse(data)
      if (!parsed.success) return null
      const s = parsed.data
      return {
        id: s.id,
        status: s.status,
        goal: s.goal ?? undefined,
        mode: s.mode ?? undefined,
        triggerType: s.triggerType ?? undefined,
        targetId: s.targetId ?? undefined,
        startedAt: toDate(s.startedAt),
        endedAt: toDate(s.endedAt),
        durationMs: s.durationMs ?? undefined,
        createdAt: toDate(s.createdAt),
        updatedAt: toDate(s.updatedAt),
        summary: s.summary ?? undefined,
        errorCategory: s.errorCategory ?? undefined,
        errorMessage: s.errorMessage ?? undefined,
        target: s.target ?? undefined,
      }
    } catch {
      return null
    }
  }

  /**
   * Resolve the durable record behind a task id. The in-memory cache is only
   * a fast path: on a miss the operation ledger is consulted over REST, which
   * is also the restart-recovery path (id → operation → resultLocation scan).
   */
  async function resolveEntry(taskId: string): Promise<LocalTaskEntry | null> {
    const recordId = parseTaskId(taskId)
    if (!recordId) return null

    const cached = entries.get(taskId)
    if (cached) {
      if (isTaskMappingExpired(new Date(cached.createdAtMs), new Date())) {
        entries.delete(taskId)
        return null
      }
      return cached
    }

    const workspaceId = await resolveWorkspaceId()
    if (!workspaceId) return null

    const op = await fetchOperationStatus(recordId, workspaceId)
    if (op) {
      const createdAtMs = new Date(op.createdAt).getTime()
      if (isTaskMappingExpired(new Date(createdAtMs), new Date())) return null
      const entry: LocalTaskEntry = {
        taskId,
        operationId: recordId,
        scanId: op.resultLocation,
        workspaceId,
        createdAtMs,
      }
      entries.set(taskId, entry)
      return entry
    }

    // Scan-bound fallback (tasks bound directly to a scan id).
    const scan = await fetchScan(recordId, workspaceId)
    if (!scan) return null
    const createdAtMs = (scan.createdAt ?? new Date()).getTime()
    if (isTaskMappingExpired(new Date(createdAtMs), new Date())) return null
    const entry: LocalTaskEntry = {
      taskId,
      operationId: null,
      scanId: scan.id,
      workspaceId,
      createdAtMs,
    }
    entries.set(taskId, entry)
    return entry
  }

  async function resolveTaskState(taskId: string): Promise<{
    entry: LocalTaskEntry
    scan: TaskScanRecord | null
    operationStatus: string | null
  } | null> {
    const entry = await resolveEntry(taskId)
    if (!entry) return null
    const scan = entry.scanId ? await fetchScan(entry.scanId, entry.workspaceId) : null
    const operationStatus = entry.operationId
      ? ((await fetchOperationStatus(entry.operationId, entry.workspaceId))?.status ?? null)
      : null
    return { entry, scan, operationStatus }
  }

  return {
    async createTask({ toolName, args, toolResult }) {
      assertTaskCapableTool(toolName)
      if (toolResult.isError) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "Task creation failed: the recorded call returned an error result.",
          toolResult.structuredContent
        )
      }
      const workspaceId = z.string().min(1).parse(args.workspaceId)
      const scanId = extractScanIdFromToolResult(toolResult)
      if (!scanId) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "Task creation failed: the recorded call produced no scan to track."
        )
      }
      const structured = toolResult.structuredContent ?? {}
      const operationId =
        z.string().min(1).safeParse(structured.operationId).data ??
        (() => {
          const scanObj = z
            .object({ operationId: z.string().min(1).optional() })
            .safeParse(structured.scan ?? {})
          return scanObj.success ? scanObj.data.operationId : undefined
        })()
      const recordId = operationId ?? scanId
      const taskId = serializeTaskId(recordId)
      const entry: LocalTaskEntry = {
        taskId,
        operationId: operationId ?? null,
        scanId,
        workspaceId,
        createdAtMs: Date.now(),
      }
      entries.set(taskId, entry)
      return buildTask({
        taskId,
        view: { status: "working", lastUpdatedAt: new Date(entry.createdAtMs).toISOString() },
        createdAt: new Date(entry.createdAtMs),
      })
    },

    async getTask(taskId) {
      const resolved = await resolveTaskState(taskId)
      if (!resolved) return null
      const { entry, scan, operationStatus } = resolved
      const status = scan
        ? mapScanStatusToTaskStatus(scan.status)
        : operationStatus === "COMPLETED"
          ? "completed"
          : operationStatus === "FAILED" || operationStatus === "CONFLICT"
            ? "failed"
            : "working"
      const lastUpdated = scan?.updatedAt ?? scan?.endedAt ?? scan?.createdAt ?? new Date()
      return buildTask({
        taskId,
        view: {
          status,
          ...(status === "failed" ? { statusMessage: "The recorded operation failed." } : {}),
          lastUpdatedAt: lastUpdated.toISOString(),
        },
        createdAt: new Date(entry.createdAtMs),
      })
    },

    async getTaskResult(taskId) {
      const resolved = await resolveTaskState(taskId)
      if (!resolved) {
        throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`)
      }
      const { scan, operationStatus } = resolved
      if (scan) {
        const status = mapScanStatusToTaskStatus(scan.status)
        if (!isTerminalTaskStatus(status)) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Task ${taskId} has no result yet (status: ${status}).`
          )
        }
        return scanRowToCallToolResult({ scan })
      }
      if (operationStatus === "FAILED" || operationStatus === "CONFLICT") {
        const payload = {
          error: "The recorded operation failed before a result could be retained.",
        }
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          isError: true,
          structuredContent: payload,
        } as CallToolResult
      }
      throw new McpError(ErrorCode.InvalidRequest, `Task ${taskId} has no result yet.`)
    },

    async cancelTask(taskId) {
      const resolved = await resolveTaskState(taskId)
      if (!resolved) return null
      const { entry, scan } = resolved
      if (!scan) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "Task cannot be cancelled: the recorded submission has not produced a scan."
        )
      }
      if (isTerminalTaskStatus(mapScanStatusToTaskStatus(scan.status))) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Cannot cancel task in terminal status: ${mapScanStatusToTaskStatus(scan.status)}`
        )
      }
      // The same canonical cancel the REST/agent path uses — resolve
      // cancellation/completion races from durable state, never local memory.
      const data = await client().request("POST", `/scans/${encodeURIComponent(scan.id)}`, {
        body: { workspaceId: entry.workspaceId },
        headers: { "Idempotency-Key": `mcp-task-cancel:${taskId}` },
      })
      const cancelled = restScanSchema.safeParse(data)
      const status = cancelled.success ? cancelled.data.status : "CANCELLED"
      entry.scanId = scan.id
      return buildTask({
        taskId,
        view: {
          status: mapScanStatusToTaskStatus(status),
          statusMessage: "Scan cancelled",
          lastUpdatedAt: new Date().toISOString(),
        },
        createdAt: new Date(entry.createdAtMs),
      })
    },

    async listTasks() {
      // Session-lifetime list: the ledger exposes no principal-scoped task
      // listing over REST, so only tasks this process created (or resolved)
      // appear. Bounded for sanity.
      const tasks: Task[] = []
      for (const entry of [...entries.values()].slice(0, 100)) {
        const task = await this.getTask(entry.taskId)
        if (task) tasks.push(task)
      }
      return { tasks }
    },
  }
}
