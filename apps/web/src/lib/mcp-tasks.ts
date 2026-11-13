import {
  MCP_TASK_TTL_MS,
  McpError,
  McpToolResultSchema,
  ErrorCode,
  assertTaskCapableTool,
  buildTask,
  extractOperationIdFromToolResult,
  extractScanIdFromOperation,
  isTerminalTaskStatus,
  resolveTaskView,
  resolveOperationStatusTaskView,
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
  claimOrGetAgentOperation,
  checkDelegatedOperationAuthorization,
  completeAgentOperation,
  failAgentOperation,
  retryScanCancellation,
  withWorkspaceRLS,
  type AgentOperation,
} from "@lyrashield/db"
import { requireOAuthPermission, type OAuthAuthContext } from "@lyrashield/auth/server"
import { PERMISSIONS, type Permission } from "@lyrashield/auth"
import { CANONICAL_OPERATIONS } from "@lyrashield/types"
import { publicScanToolResult } from "./scan-tool-provenance"
import { resolveHostedTask, type HostedResolvedTask } from "./hosted-mcp-task-access"
import { listHostedTasks, SCAN_TASK_SELECT, type ScanTaskRow } from "./hosted-mcp-task-list"

const MCP_TASK_CANCEL_RETRY_AFTER_MS = 2 * 60 * 1000

/**
 * Hosted MCP task backend — the durable side of the MCP tasks surface.
 *
 * A task id is `lst_<agentOperationId>`: a pointer into the SAME ledger row
 * the recorded tools/call boundary produced, never a capability. Every
 * accessor re-runs the live authorization chain for THIS request:
 *
 *   1. bearer → connection was already re-read by verifyOAuthBearer on this
 *      request (status, expiry, scopes, authorizationVersion),
 *   2. requireOAuthPermission re-checks the verified OAuth user's live
 *      membership, role, scopes and delegated grant,
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

interface HostedTaskConnection {
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
  oauth: OAuthAuthContext
  connection: HostedTaskConnection
  /** Test hook — the SDK waits `task.pollInterval` between result polls. */
  pollIntervalMs?: number
}

function toOperationRecord(operation: AgentOperation): TaskOperationRecord {
  const record: TaskOperationRecord = operation
  return record
}

function notFound(taskId: string): McpError {
  // Uniform, bounded denial — never confirm or deny that a row exists.
  return new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`)
}

function assertTaskCancellable(
  disclosure: "FULL" | "STATUS_ONLY",
  scan: TaskScanRecord | null,
  operation: AgentOperation
): asserts scan is ScanTaskRow {
  if (disclosure === "STATUS_ONLY") {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Task cannot be cancelled without a currently authorized active target."
    )
  }
  if (!scan || scan.id !== extractScanIdFromOperation(toOperationRecord(operation))) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Task cannot be cancelled: the recorded submission has not produced a scan."
    )
  }
}

function taskFromResolved(
  taskId: string,
  resolved: HostedResolvedTask,
  pollIntervalMs?: number
): Task {
  const view =
    resolved.disclosure === "STATUS_ONLY"
      ? resolveOperationStatusTaskView(resolved.status)
      : resolveTaskView({ operation: toOperationRecord(resolved.operation), scan: resolved.scan })
  return buildTask({
    taskId,
    view,
    createdAt: resolved.operation.createdAt,
    ttl: MCP_TASK_TTL_MS,
    ...(pollIntervalMs !== undefined ? { pollInterval: pollIntervalMs } : {}),
  })
}

export function makeHostedMcpTaskBackend(options: HostedMcpTaskOptions): McpTaskBackend {
  const { oauth, connection } = options
  const workspaceId = oauth.workspaceId
  if (oauth.connectionId !== connection.id || connection.workspaceId !== workspaceId) {
    throw new Error("Hosted MCP tasks require a matching verified OAuth connection.")
  }
  const principal = {
    principalType: "OAUTH_CONNECTION" as const,
    principalId: connection.id,
    authorizationVersion: connection.authorizationVersion,
  }

  async function fetchScan(scanId: string): Promise<ScanTaskRow | null> {
    const scan = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.scan.findFirst({
        where: { id: scanId, workspaceId, deletedAt: null, target: { deletedAt: null } },
        select: SCAN_TASK_SELECT,
      })
    )
    return (scan as ScanTaskRow | null) ?? null
  }

  const resolve = (taskId: string, permission: Permission) =>
    resolveHostedTask({
      taskId,
      permission,
      workspaceId,
      oauth,
      connection,
      principal,
      fetchScan,
    })

  const toTask = (taskId: string, resolved: HostedResolvedTask) =>
    taskFromResolved(taskId, resolved, options.pollIntervalMs)

  return {
    async createTask({ toolName, toolResult }) {
      assertTaskCapableTool(toolName)
      try {
        await requireOAuthPermission(oauth, PERMISSIONS.scan.view)
      } catch {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "Task creation was not authorized for this call."
        )
      }

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

      const resolved = await resolve(serializeTaskId(operationId), PERMISSIONS.scan.view)
      if (!resolved) {
        throw new McpError(
          ErrorCode.InternalError,
          "The recorded operation could not be bound to a task."
        )
      }
      return toTask(serializeTaskId(operationId), resolved)
    },

    async getTask(taskId) {
      const resolved = await resolve(taskId, PERMISSIONS.scan.view)
      return resolved ? toTask(taskId, resolved) : null
    },

    async getTaskResult(taskId) {
      const resolved = await resolve(taskId, PERMISSIONS.scan.view)
      if (!resolved) throw notFound(taskId)

      const { operation, scan, disclosure } = resolved
      if (disclosure === "STATUS_ONLY") {
        const payload = {
          operationId: operation.id,
          status: resolved.status.status,
          ...(resolved.status.resultLocation
            ? { scan: { id: resolved.status.resultLocation } }
            : {}),
        }
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          ...(resolved.status.status === "FAILED" ? { isError: true } : {}),
        }
      }
      const view = resolveTaskView({ operation: toOperationRecord(operation), scan })
      if (!isTerminalTaskStatus(view.status)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Task ${taskId} has no result yet (status: ${view.status}).`
        )
      }

      // Terminal results are reconstructed only from persisted state —
      // the tool handler never runs on a recovery call.
      const stored = McpToolResultSchema.safeParse(operation.result)
      if (scan && operation.status === "COMPLETED" && !(stored.success && stored.data.isError)) {
        return scanRowToCallToolResult({ scan })
      }
      if (operation.result) {
        try {
          const result = storedResultToCallToolResult(operation.result)
          if (result.isError) return publicScanToolResult(result)
        } catch {
          // fall through to the bounded generic result
        }
      }
      const payload = { error: view.statusMessage ?? "The recorded task result is unavailable." }
      const unavailableResult: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        isError: true,
        structuredContent: payload,
      }
      return unavailableResult
    },

    async cancelTask(taskId) {
      const resolved = await resolve(taskId, PERMISSIONS.scan.cancel)
      if (!resolved) throw notFound(taskId)

      const { operation, scan, disclosure } = resolved
      assertTaskCancellable(disclosure, scan, operation)
      const view = resolveTaskView({ operation: toOperationRecord(operation), scan })

      // Re-verify the delegated cancel grant for THIS request.
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

      let cancelClaim = await claimOrGetAgentOperation({
        workspaceId,
        connectionId: connection.id,
        authorizationVersion: connection.authorizationVersion,
        operationName: CANONICAL_OPERATIONS.SCAN_CANCEL,
        idempotencyKey: `mcp-task-cancel:${taskId}`,
        input: { taskId, scanId: scan.id },
      })
      if (cancelClaim.status !== "NEW") {
        const after = await resolve(taskId, PERMISSIONS.scan.view)
        const afterView = after
          ? resolveTaskView({ operation: toOperationRecord(after.operation), scan: after.scan })
          : null
        if (after && afterView?.status === "cancelled") {
          if (cancelClaim.status === "REPLAY") return toTask(taskId, after)
          if (cancelClaim.status === "IN_PROGRESS" || cancelClaim.status === "FAILED") {
            await completeAgentOperation(cancelClaim.operation.id, workspaceId, {
              resultReference: scan.id,
              result: {
                taskId,
                scanId: scan.id,
                status: afterView.status.toUpperCase(),
              },
            })
            return toTask(taskId, after)
          }
        }
        if (
          afterView &&
          !isTerminalTaskStatus(afterView.status) &&
          (cancelClaim.status === "FAILED" ||
            (cancelClaim.status === "IN_PROGRESS" &&
              Date.now() - cancelClaim.operation.updatedAt.getTime() >=
                MCP_TASK_CANCEL_RETRY_AFTER_MS))
        ) {
          cancelClaim =
            (await retryScanCancellation(
              cancelClaim.operation.id,
              workspaceId,
              new Date(Date.now() - MCP_TASK_CANCEL_RETRY_AFTER_MS)
            )) ?? cancelClaim
        }
        if (cancelClaim.status === "REPLAY") {
          const latest = await resolve(taskId, PERMISSIONS.scan.view)
          const latestView = latest
            ? resolveTaskView({ operation: toOperationRecord(latest.operation), scan: latest.scan })
            : null
          if (latest && latestView?.status === "cancelled") return toTask(taskId, latest)
        }
        if (cancelClaim.status !== "NEW") {
          const reason =
            cancelClaim.status === "CONFLICT"
              ? cancelClaim.message
              : `Cancellation operation is ${cancelClaim.status.toLowerCase()}; current task status is ${afterView?.status ?? "unavailable"}.`
          throw new McpError(ErrorCode.InvalidRequest, reason)
        }
      }

      const cancellationAttemptUpdatedAt = cancelClaim.operation.updatedAt

      if (isTerminalTaskStatus(view.status)) {
        await failAgentOperation(cancelClaim.operation.id, workspaceId, {
          error: "TASK_CANCELLATION_TERMINAL",
          resultReference: scan.id,
          expectedUpdatedAt: cancellationAttemptUpdatedAt,
        }).catch(() => undefined)
        throw new McpError(
          ErrorCode.InvalidParams,
          `Cannot cancel task in terminal status: ${view.status}`
        )
      }

      try {
        await cancelScan(scan.id, workspaceId)
      } catch {
        // Completion/cancellation race: re-read durable state.
        const after = await resolve(taskId, PERMISSIONS.scan.view)
        const afterView = after
          ? resolveTaskView({ operation: toOperationRecord(after.operation), scan: after.scan })
          : null
        if (after && afterView?.status === "cancelled") {
          await completeAgentOperation(cancelClaim.operation.id, workspaceId, {
            resultReference: scan.id,
            result: { taskId, scanId: scan.id, status: "CANCELLED" },
          })
          return toTask(taskId, after)
        }
        await failAgentOperation(cancelClaim.operation.id, workspaceId, {
          error: "TASK_CANCELLATION_FAILED",
          resultReference: scan.id,
          expectedUpdatedAt: cancellationAttemptUpdatedAt,
        }).catch(() => undefined)
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Task cancellation failed${afterView ? ` (current status: ${afterView.status})` : ""}.`
        )
      }

      const after = await resolve(taskId, PERMISSIONS.scan.view)
      const afterView = after
        ? resolveTaskView({ operation: toOperationRecord(after.operation), scan: after.scan })
        : null
      if (!after || !afterView) {
        await failAgentOperation(cancelClaim.operation.id, workspaceId, {
          error: "TASK_CANCELLATION_STATUS_UNAVAILABLE",
          resultReference: scan.id,
          expectedUpdatedAt: cancellationAttemptUpdatedAt,
        }).catch(() => undefined)
        throw notFound(taskId)
      }
      if (afterView.status !== "cancelled") {
        await failAgentOperation(cancelClaim.operation.id, workspaceId, {
          error: "TASK_CANCELLATION_NOT_CONFIRMED",
          resultReference: scan.id,
          expectedUpdatedAt: cancellationAttemptUpdatedAt,
        }).catch(() => undefined)
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Task cancellation was not confirmed (current status: ${afterView.status}).`
        )
      }
      await completeAgentOperation(cancelClaim.operation.id, workspaceId, {
        resultReference: scan.id,
        result: { taskId, scanId: scan.id, status: afterView.status.toUpperCase() },
      })
      return toTask(taskId, after)
    },

    async listTasks(cursor) {
      let member
      try {
        member = (await requireOAuthPermission(oauth, PERMISSIONS.scan.view)).workspace.member
      } catch {
        throw new McpError(ErrorCode.InvalidRequest, "Tasks are unavailable.")
      }

      return listHostedTasks({
        workspaceId,
        oauth,
        connection,
        principal,
        member,
        cursor,
        ttlMs: MCP_TASK_TTL_MS,
        ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      })
    },
  }
}
