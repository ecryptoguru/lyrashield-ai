import {
  buildTask,
  extractScanIdFromOperation,
  resolveTaskView,
  resolveOperationStatusTaskView,
  serializeTaskId,
  type Task,
  type TaskOperationRecord,
  type TaskScanRecord,
} from "@lyrashield/mcp"
import { listAgentOperationsForTasks, withWorkspaceRLS } from "@lyrashield/db"
import { CANONICAL_OPERATIONS } from "@lyrashield/types"
import type { OAuthAuthContext } from "@lyrashield/auth/server"
import { filterHostedTaskOperations } from "./hosted-mcp-task-access"

export const SCAN_TASK_SELECT = {
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

export type ScanTaskRow = TaskScanRecord & { targetId: string | null }

export async function listHostedTasks(params: {
  workspaceId: string
  oauth: OAuthAuthContext
  connection: { id: string; workspaceId: string; authorizationVersion: number }
  principal: {
    principalType: "OAUTH_CONNECTION"
    principalId: string
    authorizationVersion?: number
  }
  member: { id: string; role: string; updatedAt: Date }
  cursor?: string
  ttlMs: number
  pollIntervalMs?: number
}): Promise<{ tasks: Task[]; nextCursor?: string }> {
  const page = await listAgentOperationsForTasks({
    workspaceId: params.workspaceId,
    principalType: params.principal.principalType,
    principalId: params.principal.principalId,
    operationName: CANONICAL_OPERATIONS.SCAN_CREATE,
    cursor: params.cursor,
    limit: 21,
  })
  const considered = page.slice(0, 20)
  const items = await filterHostedTaskOperations({
    operations: considered,
    workspaceId: params.workspaceId,
    oauth: params.oauth,
    connection: params.connection,
    principal: params.principal,
    member: params.member,
    now: new Date(),
  })
  const nextCursor = page.length > 20 ? considered[considered.length - 1]?.id : undefined
  const scanIds = items
    .filter((access) => access.disclosure === "FULL")
    .map((access) => extractScanIdFromOperation(access.operation as TaskOperationRecord))
    .filter((id): id is string => !!id)
  const scans =
    scanIds.length > 0
      ? await withWorkspaceRLS(params.workspaceId, (tx) =>
          tx.scan.findMany({
            where: {
              id: { in: scanIds },
              workspaceId: params.workspaceId,
              deletedAt: null,
              target: { deletedAt: null },
            },
            select: SCAN_TASK_SELECT,
          })
        )
      : []
  const scanById = new Map(scans.map((scan) => [scan.id, scan as ScanTaskRow]))
  const tasks = items.map((access) => {
    const scanId = extractScanIdFromOperation(access.operation as TaskOperationRecord)
    const scan = access.disclosure === "FULL" && scanId ? (scanById.get(scanId) ?? null) : null
    const view =
      access.disclosure === "STATUS_ONLY"
        ? resolveOperationStatusTaskView(access.status)
        : resolveTaskView({ operation: access.operation as TaskOperationRecord, scan })
    return buildTask({
      taskId: serializeTaskId(access.operation.id),
      view,
      createdAt: access.operation.createdAt,
      ttl: params.ttlMs,
      ...(params.pollIntervalMs !== undefined ? { pollInterval: params.pollIntervalMs } : {}),
    })
  })
  return nextCursor ? { tasks, nextCursor } : { tasks }
}
