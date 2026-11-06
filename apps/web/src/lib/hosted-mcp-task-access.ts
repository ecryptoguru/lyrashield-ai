import {
  getDelegatedOperationAccess,
  type AgentOperation,
  type DelegatedOperationDisclosure,
  type OperationStatusView,
} from "@lyrashield/db"
import {
  isTaskMappingExpired,
  operationMatchesPrincipal,
  parseTaskId,
  type TaskOperationRecord,
  type TaskScanRecord,
} from "@lyrashield/mcp"
import { requireOAuthPermission, type OAuthAuthContext } from "@lyrashield/auth/server"
import type { Permission } from "@lyrashield/auth"

export interface HostedTaskConnection {
  id: string
  workspaceId: string
  authorizationVersion: number
}

export interface HostedResolvedTask {
  operation: AgentOperation
  scan: TaskScanRecord | null
  disclosure: DelegatedOperationDisclosure
  status: OperationStatusView
}

interface AccessParams {
  workspaceId: string
  oauth: OAuthAuthContext
  connection: HostedTaskConnection
  member: { id: string; role: string; updatedAt: Date }
}

function accessParams(operationId: string, params: AccessParams) {
  return {
    operationId,
    workspaceId: params.workspaceId,
    userId: params.oauth.userId,
    memberId: params.member.id,
    memberRole: params.member.role,
    memberUpdatedAt: params.member.updatedAt,
    connectionId: params.connection.id,
    authorizationVersion: params.connection.authorizationVersion,
  }
}

export async function resolveHostedTask(params: {
  taskId: string
  permission: Permission
  workspaceId: string
  oauth: OAuthAuthContext
  connection: HostedTaskConnection
  principal: { principalType: string; principalId: string; authorizationVersion?: number }
  fetchScan: (scanId: string) => Promise<TaskScanRecord | null>
}): Promise<HostedResolvedTask | null> {
  const operationId = parseTaskId(params.taskId)
  if (!operationId) return null
  let member
  try {
    member = (await requireOAuthPermission(params.oauth, params.permission)).workspace.member
  } catch {
    return null
  }
  const access = await getDelegatedOperationAccess(
    accessParams(operationId, {
      workspaceId: params.workspaceId,
      oauth: params.oauth,
      connection: params.connection,
      member,
    })
  )
  if (
    !access ||
    !operationMatchesPrincipal(access.operation as TaskOperationRecord, params.principal) ||
    isTaskMappingExpired(access.operation.createdAt, new Date())
  ) {
    return null
  }
  const scanId = access.operation.resultReference
  const scan = access.disclosure === "FULL" && scanId ? await params.fetchScan(scanId) : null
  return { operation: access.operation, scan, disclosure: access.disclosure, status: access.status }
}

export async function filterHostedTaskOperations(params: {
  operations: AgentOperation[]
  workspaceId: string
  oauth: OAuthAuthContext
  connection: HostedTaskConnection
  principal: { principalType: string; principalId: string; authorizationVersion?: number }
  member: { id: string; role: string; updatedAt: Date }
  now?: Date
}) {
  const accesses = await Promise.all(
    params.operations.map(async (operation) => {
      if (
        !operationMatchesPrincipal(operation as TaskOperationRecord, params.principal) ||
        isTaskMappingExpired(operation.createdAt, params.now ?? new Date())
      ) {
        return null
      }
      const access = await getDelegatedOperationAccess(accessParams(operation.id, params))
      return access &&
        operationMatchesPrincipal(access.operation as TaskOperationRecord, params.principal)
        ? access
        : null
    })
  )
  return accesses.filter((access): access is NonNullable<typeof access> => !!access)
}
