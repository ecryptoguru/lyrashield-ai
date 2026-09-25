import {
  MCP_TASK_TTL_MS,
  McpError,
  ErrorCode,
  assertTaskCapableTool,
  buildTask,
  extractOperationIdFromToolResult,
  extractScanIdFromOperation,
  isTaskMappingExpired,
  isTerminalTaskStatus,
  operationMatchesPrincipal,
  parseTaskId,
  resolveTaskView,
  scanRowToCallToolResult,
  serializeTaskId,
  storedResultToCallToolResult,
  type CallToolResult,
  type McpTaskBackend,
  type Task,
  type TaskOperationRecord,
  type TaskScanRecord,
} from "@lyrashield/mcp"
import {
  cancelScan,
  checkDelegatedOperationAuthorization,
  getAgentOperation,
  listAgentOperationsForTasks,
  withWorkspaceRLS,
  type AgentOperation,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS, type Permission } from "@lyrashield/auth"
import { CANONICAL_OPERATIONS } from "@lyrashield/db"

/**
 * Hosted MCP task backend — the durable side of the MCP tasks surface.
 *
 * A task id is `lst_<agentOperationId>`: a pointer into the SAME ledger row
 * the recorded tools/call boundary produced, never a capability. Every
 * accessor re-runs the live authorization chain for THIS request:
 *
 *   1. bearer → connection was already re-read by verifyOAuthBearer on this
 *      request (status, expiry, scopes, authorizationVersion),
 *   2. requirePermission(workspaceId, scan.view|scan.cancel) re-checks live
 *      membership, role and delegated grant,
 *   3. the operation row must match the current principal AND the
 *      authorizationVersion persisted at binding time, and
 *   4. the mapping must be inside the retention TTL.
 *
 * Any failure resolves to a uniform "task not found" — a foreign or stale
 * task id can never confirm a row exists or pull another principal's result.
 *
 * Nothing is ever executed here: createTask only binds the operation id the
 * gate already recorded; getTaskResult reconstructs terminal results from the
 * persisted operation/scan rows; tasks/cancel routes into the canonical
 * scan.cancel path. Recovery calls can never duplicate a paid scan.
 */

export interface HostedTaskConnection {
  id: string
  workspaceId: string
  status: "ACTIVE"
  authorizationVersion: number
  allowedOperations: string[]
  allowedTargetIds: string[]
  allTargets: boolean
  allowedProfiles: string[]
  expiresAt: Date | null
}

export interface HostedMcpTaskOptions {
  workspaceId: string
  connection: HostedTaskConnection
  /** Test hook — the SDK waits `task.pollInterval` between result polls. */
  pollIntervalMs?: number
}

const SCAN_TASK_SELECT = {
  id: true,
  status: true,
  goal: true,
  mode: true,
  triggerType: true,
  targetId: true,
  startedAt: true,
  endedAt: true,
  durationMs: true,
  createdAt: true,
  updatedAt: true,
  summary: true,
  errorCategory: true,
  errorMessage: true,
  target: {
    select: { id: true, name: true, type: true, url: true, apiSpecUrl: true, repoFullName: true },
  },
} as const

type ScanTaskRow = TaskScanRecord & { targetId: string | null }

interface ResolvedTask {
  operation: AgentOperation
  scan: ScanTaskRow | null
}

function toOperationRecord(operation: AgentOperation): TaskOperationRecord {
  return operation as TaskOperationRecord
}

function notFound(taskId: string): McpError {
  // Uniform, bounded denial — never confirm or deny that a row exists.
  return new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`)
}

export function makeHostedMcpTaskBackend(options: HostedMcpTaskOptions): McpTaskBackend {
  const { workspaceId, connection } = options
  const principal = {
    principalType: "OAUTH_CONNECTION" as const,
    principalId: connection.id,
    authorizationVersion: connection.authorizationVersion,
  }

  async function fetchScan(scanId: string): Promise<ScanTaskRow | null> {
    const scan = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.scan.findFirst({
        where: { id: scanId, workspaceId, deletedAt: null },
        select: SCAN_TASK_SELECT,
      })
    )
    return (scan as ScanTaskRow | null) ?? null
  }

  /**
   * Resolve the durable binding behind a task id under THIS request's
   * authorization. Returns null for anything malformed, foreign, stale-version
   * or expired — the caller maps that to a uniform "task not found".
   */
  async function resolve(taskId: string, permission: Permission): Promise<ResolvedTask | null> {
    const operationId = parseTaskId(taskId)
    if (!operationId) return null

    // Live membership/role/scope/delegated-grant check for this request.
    try {
      await requirePermission(workspaceId, permission)
    } catch {
      return null
    }

    const operation = await getAgentOperation(operationId, workspaceId)
    if (!operation) return null
    // The bound principal and the grant version recorded at creation must
    // still match this request's connection — a re-scoped/reissued grant
    // (authorizationVersion bump) invalidates every prior binding.
    if (!operationMatchesPrincipal(toOperationRecord(operation), principal)) return null
    if (isTaskMappingExpired(operation.createdAt, new Date())) return null

    const scanId = extractScanIdFromOperation(toOperationRecord(operation))
    const scan = scanId ? await fetchScan(scanId) : null
    return { operation, scan }
  }

  function toTask(taskId: string, resolved: ResolvedTask): Task {
    const view = resolveTaskView({
      operation: toOperationRecord(resolved.operation),
      scan: resolved.scan,
    })
    return buildTask({
      taskId,
      view,
      createdAt: resolved.operation.createdAt,
      ttl: MCP_TASK_TTL_MS,
      ...(options.pollIntervalMs !== undefined ? { pollInterval: options.pollIntervalMs } : {}),
    })
  }

  return {
    async createTask({ toolName, toolResult }) {
      assertTaskCapableTool(toolName)
      const operationId = extractOperationIdFromToolResult(toolResult)
      if (!operationId) {
        if (toolResult.isError) {
          // Denied/unauthorized recorded calls never produced a ledger row —
          // surface the bounded denial payload, do not fabricate a task.
          throw new McpError(
            ErrorCode.InvalidRequest,
            "Task creation was not authorized for this call.",
            toolResult.structuredContent
          )
        }
        throw new McpError(
          ErrorCode.InternalError,
          "The recorded call did not produce a durable operation to bind."
        )
      }

      const operation = await getAgentOperation(operationId, workspaceId)
      if (!operation || !operationMatchesPrincipal(toOperationRecord(operation), principal)) {
        throw new McpError(
          ErrorCode.InternalError,
          "The recorded operation could not be bound to a task."
        )
      }
      const scanId = extractScanIdFromOperation(toOperationRecord(operation))
      const scan = scanId ? await fetchScan(scanId) : null
      return toTask(serializeTaskId(operationId), { operation, scan })
    },

    async getTask(taskId) {
      const resolved = await resolve(taskId, PERMISSIONS.scan.view)
      return resolved ? toTask(taskId, resolved) : null
    },

    async getTaskResult(taskId) {
      const resolved = await resolve(taskId, PERMISSIONS.scan.view)
      if (!resolved) throw notFound(taskId)

      const { operation, scan } = resolved
      const view = resolveTaskView({ operation: toOperationRecord(operation), scan })
      if (!isTerminalTaskStatus(view.status)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Task ${taskId} has no result yet (status: ${view.status}).`
        )
      }

      // Terminal results are reconstructed only from persisted state —
      // the tool handler never runs on a recovery call.
      if (scan) return scanRowToCallToolResult({ scan })
      if (operation.result) {
        try {
          return storedResultToCallToolResult(operation.result)
        } catch {
          // fall through to the bounded generic result
        }
      }
      const payload = { error: "The recorded task result is unavailable." }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        isError: true,
        structuredContent: payload,
      } as CallToolResult
    },

    async cancelTask(taskId) {
      const resolved = await resolve(taskId, PERMISSIONS.scan.cancel)
      if (!resolved) throw notFound(taskId)

      const { operation, scan } = resolved
      const view = resolveTaskView({ operation: toOperationRecord(operation), scan })
      if (isTerminalTaskStatus(view.status)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Cannot cancel task in terminal status: ${view.status}`
        )
      }
      if (!scan || scan.id !== extractScanIdFromOperation(toOperationRecord(operation))) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "Task cannot be cancelled: the recorded submission has not produced a scan."
        )
      }

      // Re-verify the delegated cancel grant for THIS request — live
      // operation grant and target scope, not the binding's snapshot.
      const authCheck = checkDelegatedOperationAuthorization({
        connection,
        workspaceId,
        operationName: "lyrashield_cancel_scan",
        targetId: scan.targetId ?? undefined,
      })
      if (!authCheck.authorized) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Task cancellation is not authorized: ${authCheck.reason}`
        )
      }

      try {
        await cancelScan(scan.id, workspaceId)
      } catch {
        // Completion/cancellation race: re-resolve from durable state instead
        // of trusting the error — the SDK requires a terminal-status error
        // only when the task is still terminal after the race.
        const after = await resolve(taskId, PERMISSIONS.scan.view)
        const afterView = after
          ? resolveTaskView({ operation: toOperationRecord(after.operation), scan: after.scan })
          : null
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Task cancellation failed${afterView ? ` (current status: ${afterView.status})` : ""}.`
        )
      }

      const after = await resolve(taskId, PERMISSIONS.scan.view)
      if (!after) throw notFound(taskId)
      return toTask(taskId, after)
    },

    async listTasks(cursor) {
      const page = await listAgentOperationsForTasks({
        workspaceId,
        principalType: principal.principalType,
        principalId: principal.principalId,
        operationName: CANONICAL_OPERATIONS.SCAN_CREATE,
        cursor,
        limit: 21,
      })
      // Fetch 21 rows as a has-more probe; only the first 20 are consumed.
      // The cursor resumes strictly after the 20th, so no valid row is lost
      // even when principal/version/expiry filtering removes entries.
      const considered = page.slice(0, 20)
      const now = new Date()
      const items = considered.filter(
        (op) =>
          operationMatchesPrincipal(toOperationRecord(op), principal) &&
          !isTaskMappingExpired(op.createdAt, now)
      )
      const nextCursor = page.length > 20 ? considered[considered.length - 1]?.id : undefined

      const scanIds = items
        .map((op) => extractScanIdFromOperation(toOperationRecord(op)))
        .filter((id): id is string => !!id)
      const scans =
        scanIds.length > 0
          ? await withWorkspaceRLS(workspaceId, (tx) =>
              tx.scan.findMany({
                where: { id: { in: scanIds }, workspaceId, deletedAt: null },
                select: SCAN_TASK_SELECT,
              })
            )
          : []
      const scanById = new Map(scans.map((s) => [s.id, s as ScanTaskRow]))

      const tasks = items.map((op) => {
        const scanId = extractScanIdFromOperation(toOperationRecord(op))
        return toTask(serializeTaskId(op.id), {
          operation: op,
          scan: scanId ? (scanById.get(scanId) ?? null) : null,
        })
      })
      return nextCursor ? { tasks, nextCursor } : { tasks }
    },
  }
}
