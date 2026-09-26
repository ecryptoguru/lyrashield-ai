import { z } from "zod"
import {
  ErrorCode,
  McpError,
  TaskSchema,
  type CallToolResult,
  type Task,
} from "@modelcontextprotocol/sdk/types.js"
import type { CreateTaskOptions, TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks"
import { capToolResult } from "./result-cap"
import type { McpToolResult } from "./tools"

/**
 * MCP tasks (protocol 2025-11-25) — pure glue between the SDK's experimental
 * task surface and LyraShield's durable operation ledger.
 *
 * Binding model: a task id is `lst_<agentOperationId>` — a deterministic,
 * reversible encoding, never a bearer capability. Every lookup re-resolves
 * the operation row under the caller's workspace and re-verifies principal,
 * grant version and scope before any state is returned; a malformed or
 * foreign id resolves to "not found".
 *
 * Task state is DERIVED, never stored a second time: the durable
 * AgentOperation row (and the scan row it references through
 * `resultReference`) is the single source of truth, so a fresh server
 * instance — the hosted transport builds one per request — resolves the
 * same task identically after any process replacement.
 */

/** Minimum negotiated protocol version that carries MCP task semantics. */
export const MCP_TASK_PROTOCOL_VERSION = "2025-11-25"

/** Task-id prefix: `lst_<operationId>`. Keeps task ids visually distinct. */
export const MCP_TASK_ID_PREFIX = "lst_"

/**
 * Fixed retention policy for task mappings. The requestor-suggested ttl is
 * always overridden to this value (the spec explicitly permits enforcement
 * overrides) so expiry stays a pure function of the persisted
 * `AgentOperation.createdAt` — there is nowhere else state could live on the
 * stateless hosted path.
 */
export const MCP_TASK_TTL_MS = 24 * 60 * 60 * 1000

/** Poll cadence advertised on Task and used by the SDK's tasks/result wait. */
export const MCP_TASK_POLL_INTERVAL_MS = 5000

/**
 * The one tool registered as task-capable: a recorded, delegated scan. Its
 * paid work is bounded by the same claim/execute/complete ledger boundary as
 * an immediate call, so an augmented call can never duplicate a submission.
 * `lyrashield_cancel_scan` is deliberately NOT a task — it is a bounded
 * mutation, and protocol cancellation flows through tasks/cancel.
 */
export const TASK_CAPABLE_TOOLS: ReadonlySet<string> = new Set(["lyrashield_scan_target"])

// Operation/scan ids are cuids — lowercase alphanumeric. Anything outside
// that charset is a foreign or malformed id, never a valid binding.
const operationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const taskIdSchema = z
  .string()
  .startsWith(MCP_TASK_ID_PREFIX)
  .max(MCP_TASK_ID_PREFIX.length + 128)

/** Encode a durable operation id as a public task id. */
export function serializeTaskId(operationId: string): string {
  return `${MCP_TASK_ID_PREFIX}${operationIdSchema.parse(operationId)}`
}

/** Decode a task id back to its operation id; null when malformed/foreign-shaped. */
export function parseTaskId(taskId: unknown): string | null {
  const parsed = taskIdSchema.safeParse(taskId)
  if (!parsed.success) return null
  const inner = parsed.data.slice(MCP_TASK_ID_PREFIX.length)
  return operationIdSchema.safeParse(inner).success ? inner : null
}

/** Bounded JSON-RPC error for the task surface. */
export function taskError(error: () => unknown): string {
  try {
    error()
    return ""
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Throw when a tool is not registered as task-capable. */
export function assertTaskCapableTool(toolName: string): void {
  if (!TASK_CAPABLE_TOOLS.has(toolName)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Tool ${toolName} does not support task execution. Only ${[...TASK_CAPABLE_TOOLS].join(", ")} is task-capable.`
    )
  }
}

/** MCP task status values for a non-terminal scan lifecycle. */
export type McpTaskStatus = Task["status"]

const WORKING_SCAN_STATUSES: ReadonlySet<string> = new Set([
  "QUEUED",
  "PREFLIGHT",
  "RUNNING",
  "VERIFYING",
  "REQUIRES_APPROVAL",
])
const COMPLETED_SCAN_STATUSES: ReadonlySet<string> = new Set(["COMPLETED", "PARTIAL"])
const FAILED_SCAN_STATUSES: ReadonlySet<string> = new Set(["FAILED", "STOPPED_BUDGET", "TIMED_OUT"])

/**
 * Map a durable scan status to a task status. Unknown/uncovered values map to
 * `failed` — never silently report a terminal success for an unrecognized row.
 */
export function mapScanStatusToTaskStatus(scanStatus: string): McpTaskStatus {
  if (WORKING_SCAN_STATUSES.has(scanStatus)) return "working"
  if (COMPLETED_SCAN_STATUSES.has(scanStatus)) return "completed"
  if (FAILED_SCAN_STATUSES.has(scanStatus)) return "failed"
  if (scanStatus === "CANCELLED") return "cancelled"
  return "failed"
}

export function isTerminalTaskStatus(status: McpTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

/**
 * Minimal durable shapes the adapter resolves from. They mirror the Prisma
 * models without importing them — this package stays publishable and free of
 * server-only dependencies; the hosted backend validates rows into these.
 */
export interface TaskOperationRecord {
  id: string
  status: "PENDING" | "EXECUTING" | "COMPLETED" | "FAILED" | "CONFLICT" | string
  error: string | null
  resultReference: string | null
  result: unknown
  workspaceId: string
  principalType: string
  principalId: string
  connectionId: string | null
  authorizationVersion: number
  createdAt: Date
  updatedAt: Date
}

export interface TaskScanRecord {
  id: string
  status: string
  goal?: string | null
  mode?: string | null
  triggerType?: string | null
  targetId?: string | null
  startedAt?: Date | null
  endedAt?: Date | null
  durationMs?: number | null
  createdAt?: Date | null
  updatedAt?: Date | null
  summary?: string | null
  errorCategory?: string | null
  errorMessage?: string | null
  target?: {
    id: string
    name: string
    type: string
    url?: string | null
    apiSpecUrl?: string | null
    repoFullName?: string | null
  } | null
}

export interface TaskView {
  status: McpTaskStatus
  statusMessage?: string
  lastUpdatedAt: string
}

const toolResultEnvelopeSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
})

const scanIdEnvelopeSchema = z.object({
  scan: z
    .object({ id: z.string().trim().min(1).max(128) })
    .partial()
    .optional(),
})

/** Scan id recorded on the operation — resultReference first, result payload as fallback. */
export function extractScanIdFromOperation(operation: TaskOperationRecord): string | null {
  const ref = operationIdSchema.safeParse(operation.resultReference)
  if (ref.success) return ref.data
  const envelope = toolResultEnvelopeSchema.safeParse(operation.result)
  if (!envelope.success) return null
  const nested = scanIdEnvelopeSchema.safeParse(envelope.data.structuredContent ?? {})
  return nested.success && nested.data.scan?.id ? nested.data.scan.id : null
}

/** The recorded operation id stamped onto a delegated tool result. */
export function extractOperationIdFromToolResult(result: McpToolResult): string | null {
  const parsed = operationIdSchema.safeParse(result.structuredContent?.operationId)
  return parsed.success ? parsed.data : null
}

/** The scan id inside a `scan_triggered` style tool result. */
export function extractScanIdFromToolResult(result: McpToolResult): string | null {
  const parsed = scanIdEnvelopeSchema.safeParse(result.structuredContent ?? {})
  return parsed.success && parsed.data.scan?.id ? parsed.data.scan.id : null
}

/** Principal/version gate — foreign or stale-version bindings never resolve. */
export function operationMatchesPrincipal(
  operation: TaskOperationRecord,
  principal: { principalType: string; principalId: string; authorizationVersion?: number }
): boolean {
  if (operation.principalType !== principal.principalType) return false
  if (operation.principalId !== principal.principalId) return false
  if (
    principal.authorizationVersion !== undefined &&
    operation.authorizationVersion !== principal.authorizationVersion
  )
    return false
  return true
}

/**
 * Resolve the task state from the durable operation + scan rows. This is the
 * ONLY status computation; recovery paths never re-execute the tool handler.
 */
export function resolveTaskView(params: {
  operation: TaskOperationRecord
  scan: TaskScanRecord | null
}): TaskView {
  const { operation, scan } = params
  const lastUpdatedAt = (scan?.updatedAt ?? operation.updatedAt).toISOString()

  if (operation.status === "PENDING" || operation.status === "EXECUTING") {
    return { status: "working", lastUpdatedAt }
  }
  if (operation.status === "FAILED" || operation.status === "CONFLICT") {
    return {
      status: "failed",
      statusMessage: "The recorded operation failed before a result could be retained.",
      lastUpdatedAt,
    }
  }
  // COMPLETED: the recorded tool result decides. An isError result means the
  // delegated call ran but produced no durable work.
  const stored = toolResultEnvelopeSchema.safeParse(operation.result)
  if (stored.success && stored.data.isError === true) {
    return {
      status: "failed",
      statusMessage: "The recorded call did not produce a scan.",
      lastUpdatedAt,
    }
  }
  if (!scan || scan.id !== extractScanIdFromOperation(operation)) {
    return {
      status: "failed",
      statusMessage: "The recorded task result is unavailable.",
      lastUpdatedAt,
    }
  }
  const status = mapScanStatusToTaskStatus(scan.status)
  const statusMessage =
    status === "failed"
      ? `Scan ${String(scan.status).toLowerCase().replaceAll("_", " ")}${scan.errorCategory ? ` (${scan.errorCategory})` : ""}`
      : status === "cancelled"
        ? "Scan cancelled"
        : undefined
  return { status, statusMessage, lastUpdatedAt }
}

/** The policy retention check — an expired mapping resolves to "not found". */
export function isTaskMappingExpired(operationCreatedAt: Date, now: Date): boolean {
  return operationCreatedAt.getTime() + MCP_TASK_TTL_MS <= now.getTime()
}

const scanTargetViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  url: z.string().nullable().optional(),
  apiSpecUrl: z.string().nullable().optional(),
  repoFullName: z.string().nullable().optional(),
})

/**
 * Allowlisted terminal-state constructor. A task result is built ONLY from
 * persisted scan fields — it never re-executes the tool, never invents a
 * finding count, and never surfaces cost/credential columns.
 */
export function scanRowToCallToolResult(params: { scan: TaskScanRecord }): CallToolResult {
  const { scan } = params
  const taskStatus = mapScanStatusToTaskStatus(scan.status)
  const action =
    taskStatus === "completed"
      ? "scan_completed"
      : taskStatus === "cancelled"
        ? "scan_cancelled"
        : "scan_failed"
  const scanView: Record<string, unknown> = {
    id: scan.id,
    status: scan.status,
    ...(scan.goal !== undefined ? { goal: scan.goal } : {}),
    ...(scan.mode !== undefined ? { mode: scan.mode } : {}),
    ...(scan.triggerType !== undefined ? { triggerType: scan.triggerType } : {}),
    ...(scan.targetId !== undefined ? { targetId: scan.targetId } : {}),
    startedAt: scan.startedAt ? scan.startedAt.toISOString() : null,
    endedAt: scan.endedAt ? scan.endedAt.toISOString() : null,
    durationMs: scan.durationMs ?? null,
    ...(scan.createdAt !== undefined
      ? { createdAt: scan.createdAt ? scan.createdAt.toISOString() : null }
      : {}),
    ...(scan.summary !== undefined ? { summary: scan.summary } : {}),
    ...(scan.errorCategory !== undefined ? { errorCategory: scan.errorCategory } : {}),
    ...(scan.errorMessage !== undefined ? { errorMessage: scan.errorMessage } : {}),
  }
  const target = scanTargetViewSchema.safeParse(scan.target)
  if (target.success) scanView.target = target.data
  const payload = { action, scan: scanView }
  const result: McpToolResult = {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(taskStatus !== "completed" ? { isError: true } : {}),
  }
  // The 256 KiB result cap applies to task payloads too — a giant persisted
  // summary/errorMessage truncates to a bounded, marker-stamped payload.
  return capToolResult(result) as CallToolResult
}

const storedToolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
})

/**
 * Replay a recorded tool result verbatim — used when the operation completed
 * with an error result and no scan row exists. Zod-validated so a corrupted
 * JSON column can never reach the client.
 */
export function storedResultToCallToolResult(stored: unknown): CallToolResult {
  const parsed = storedToolResultSchema.parse(stored)
  return capToolResult({
    content: parsed.content,
    ...(parsed.isError ? { isError: true } : {}),
    ...(parsed.structuredContent ? { structuredContent: parsed.structuredContent } : {}),
  }) as CallToolResult
}

/** Build a spec-shaped Task view from resolved state. */
export function buildTask(params: {
  taskId: string
  view: TaskView
  createdAt: Date
  ttl?: number | null
  pollInterval?: number
}): Task {
  return TaskSchema.parse({
    taskId: params.taskId,
    status: params.view.status,
    ttl: params.ttl === undefined ? MCP_TASK_TTL_MS : params.ttl,
    createdAt: params.createdAt.toISOString(),
    lastUpdatedAt: params.view.lastUpdatedAt,
    pollInterval: params.pollInterval ?? MCP_TASK_POLL_INTERVAL_MS,
    ...(params.view.statusMessage ? { statusMessage: params.view.statusMessage } : {}),
  })
}

/**
 * Host-side task surface. The packages/mcp transport wires the SDK's
 * installed `tasks/*` method handlers to this; the hosted app provides a
 * durable implementation bound to the AgentOperation ledger.
 */
export interface McpTaskBackend {
  /**
   * Bind a task to the durable record an already-executed, already-recorded
   * tool call produced. `toolResult` is the gate-approved outcome of
   * engine.callTool — never a second execution.
   */
  createTask(params: {
    toolName: string
    args: Record<string, unknown>
    taskParams: { ttl?: number; pollInterval?: number }
    toolResult: McpToolResult
  }): Promise<Task>
  /** Re-authorized status; null for unknown, foreign, or expired mappings. */
  getTask(taskId: string): Promise<Task | null>
  /** Re-authorized terminal result, reconstructed from durable state only. */
  getTaskResult(taskId: string): Promise<CallToolResult>
  /** Route protocol cancellation into the canonical scan-cancel path. */
  cancelTask(taskId: string, statusMessage?: string): Promise<Task | null>
  listTasks(cursor?: string): Promise<{ tasks: Task[]; nextCursor?: string }>
}

/**
 * Adapt an {@link McpTaskBackend} to the SDK's TaskStore so the Protocol-level
 * tasks/get, tasks/result, tasks/list and tasks/cancel handlers work against
 * durable state. `createTask`/`storeTaskResult` are intentionally not wired:
 * task creation goes through the recorded tools/call boundary (the transport
 * calls the backend directly), and task results are always reconstructed.
 */
export function toSdkTaskStore(backend: McpTaskBackend): TaskStore {
  return {
    createTask: async (_taskParams: CreateTaskOptions): Promise<Task> => {
      throw new McpError(
        ErrorCode.InternalError,
        "Task creation is only available through a task-augmented tools/call."
      )
    },
    getTask: (taskId: string) => backend.getTask(taskId),
    storeTaskResult: async (): Promise<void> => {
      throw new McpError(
        ErrorCode.InternalError,
        "Task results are reconstructed from durable state and cannot be stored directly."
      )
    },
    getTaskResult: (taskId: string) => backend.getTaskResult(taskId),
    updateTaskStatus: async (taskId: string, status: Task["status"], statusMessage?: string) => {
      if (status !== "cancelled") {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Task status ${status} is derived from durable state and cannot be set directly.`
        )
      }
      const task = await backend.cancelTask(taskId, statusMessage)
      if (!task) {
        throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`)
      }
    },
    listTasks: (cursor?: string) => backend.listTasks(cursor),
  }
}
