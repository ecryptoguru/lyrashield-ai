import type { AgentOperation, Prisma } from "./generated/prisma"
import { logger } from "@lyrashield/logger"
import { hashOperationInput } from "./agent-operation-hash"
import { withWorkspaceRLS } from "./rls"

function isPrismaInputJsonValue(value: unknown): value is Prisma.InputJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isPrismaInputJsonValue)
  if (typeof value === "object") return Object.values(value).every(isPrismaInputJsonValue)
  return false
}

function isPrismaInputJsonObject(value: unknown): value is Prisma.InputJsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isPrismaInputJsonValue)
  )
}

/** Normalize supported runtime values (including Dates) before storing JSON. */
export function toJsonObject(value: object): Prisma.InputJsonObject {
  const serialized = JSON.stringify(value)
  if (typeof serialized !== "string") {
    throw new TypeError("Operation result must be JSON-serializable.")
  }

  const normalized: unknown = JSON.parse(serialized)
  if (!isPrismaInputJsonObject(normalized)) {
    throw new TypeError("Operation result must be a JSON object.")
  }
  return normalized
}

export interface ClaimAgentOperationParams {
  workspaceId: string
  operationName: string
  idempotencyKey: string
  input: Record<string, unknown>
  authorizationVersion?: number
  /** OAuth connection principal. Mutually exclusive with apiKeyId/userId. */
  connectionId?: string
  /**
   * External provider connection principal (an Integration row, e.g. a GitHub
   * App installation or Slack workspace connection). Connector invocations
   * bind idempotency to the connection's stable identity, so a reconnect that
   * preserves the row also preserves operation identity. The
   * `connectionId` column stays null — that FK references agent_connections
   * only.
   */
  connectorPrincipal?: string
  /** API-key principal identity (the key id). */
  apiKeyId?: string
  /** Browser-session principal id (the user id). */
  userId?: string
}

export type PrincipalIdentity = {
  principalType: "OAUTH_CONNECTION" | "API_KEY" | "BROWSER_SESSION"
  principalId: string
  connectionId?: string
  authorizationVersion?: number
}

/**
 * Resolve the principal-bound identity for an operation claim (W3-01). An
 * OAuth connection keeps its connection-bound identity; an API key or browser
 * session is never fabricated into a connection.
 */
export function resolveOperationPrincipal(
  params: Pick<
    ClaimAgentOperationParams,
    "connectionId" | "connectorPrincipal" | "apiKeyId" | "userId"
  >
): PrincipalIdentity {
  if (params.connectionId) {
    return {
      principalType: "OAUTH_CONNECTION",
      principalId: params.connectionId,
      connectionId: params.connectionId,
    }
  }
  // An outbound-connector invocation is an OAuth-bound principal too: the
  // provider grant lives on the Integration row, and principalId carries its
  // namespaced id. `connectionId` stays null (FK to agent_connections only).
  if (params.connectorPrincipal) {
    return { principalType: "OAUTH_CONNECTION", principalId: params.connectorPrincipal }
  }
  if (params.apiKeyId) return { principalType: "API_KEY", principalId: params.apiKeyId }
  if (params.userId) return { principalType: "BROWSER_SESSION", principalId: params.userId }
  throw new Error("OPERATION_PRINCIPAL_REQUIRED")
}

export type ClaimOperationResult =
  | {
      status: "NEW"
      operation: AgentOperation
    }
  | {
      status: "REPLAY"
      operation: AgentOperation
    }
  | {
      status: "IN_PROGRESS" | "FAILED"
      operation: AgentOperation
    }
  | {
      status: "CONFLICT"
      message: string
    }

// The canonical input hash lives in agent-operation-hash (a pure module) so
// unit tests and callers can apply the exact production hashing without
// importing the Prisma-backed service surface.
export { hashOperationInput }

export async function claimOrGetAgentOperation(
  params: ClaimAgentOperationParams
): Promise<ClaimOperationResult> {
  const inputHash = hashOperationInput(params.operationName, params.input)
  const principal = resolveOperationPrincipal(params)

  // Check if an operation with the same principal-bound identity exists.
  // The principal unique index covers connectionless principals too.
  const existing = await withWorkspaceRLS(params.workspaceId, (tx) =>
    tx.agentOperation.findUnique({
      where: {
        workspaceId_principalType_principalId_operationName_idempotencyKey: {
          workspaceId: params.workspaceId,
          principalType: principal.principalType,
          principalId: principal.principalId,
          operationName: params.operationName,
          idempotencyKey: params.idempotencyKey,
        },
      },
    })
  )

  if (existing) {
    if (existing.inputHash === inputHash) {
      if (existing.status === "PENDING" || existing.status === "EXECUTING") {
        return { status: "IN_PROGRESS", operation: existing }
      }
      if (existing.status === "FAILED" || existing.status === "CONFLICT") {
        return { status: "FAILED", operation: existing }
      }
      return {
        status: "REPLAY",
        operation: existing,
      }
    } else {
      logger.warn("Idempotency key reused with conflicting input", {
        principalType: principal.principalType,
        principalId: principal.principalId,
        operationName: params.operationName,
        idempotencyKey: params.idempotencyKey,
      })
      return {
        status: "CONFLICT",
        message:
          "Idempotency key was already used for this operation with different input arguments",
      }
    }
  }

  // Create new operation
  try {
    const operation = await withWorkspaceRLS(params.workspaceId, (tx) =>
      tx.agentOperation.create({
        data: {
          workspaceId: params.workspaceId,
          connectionId: principal.connectionId ?? null,
          operationName: params.operationName,
          idempotencyKey: params.idempotencyKey,
          inputHash,
          principalType: principal.principalType,
          principalId: principal.principalId,
          authorizationVersion: params.authorizationVersion ?? 1,
          status: "EXECUTING",
        },
      })
    )

    return {
      status: "NEW",
      operation,
    }
  } catch (err: unknown) {
    // Handle concurrent create race (unique constraint violation P2002)
    const prismaErr = err as { code?: string }
    if (prismaErr.code === "P2002") {
      const raced = await withWorkspaceRLS(params.workspaceId, (tx) =>
        tx.agentOperation.findUnique({
          where: {
            workspaceId_principalType_principalId_operationName_idempotencyKey: {
              workspaceId: params.workspaceId,
              principalType: principal.principalType,
              principalId: principal.principalId,
              operationName: params.operationName,
              idempotencyKey: params.idempotencyKey,
            },
          },
        })
      )
      if (raced && raced.inputHash === inputHash) {
        if (raced.status === "COMPLETED") return { status: "REPLAY", operation: raced }
        if (raced.status === "FAILED" || raced.status === "CONFLICT") {
          return { status: "FAILED", operation: raced }
        }
        return { status: "IN_PROGRESS", operation: raced }
      }
      return {
        status: "CONFLICT",
        message: "Idempotency key conflict under concurrent submission",
      }
    }
    throw err
  }
}

export async function completeAgentOperation(
  operationId: string,
  workspaceId: string,
  params: {
    resultReference?: string
    result?: Prisma.InputJsonObject
  }
): Promise<AgentOperation> {
  return withWorkspaceRLS(workspaceId, (tx) =>
    tx.agentOperation.update({
      where: { id: operationId },
      data: {
        status: "COMPLETED",
        resultReference: params.resultReference,
        result: params.result,
      },
    })
  )
}

export async function failAgentOperation(
  operationId: string,
  workspaceId: string,
  params: { error: string; resultReference?: string; expectedUpdatedAt?: Date }
): Promise<AgentOperation> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const data = {
      status: "FAILED",
      error: params.error,
      resultReference: params.resultReference,
    } as const
    if (params.expectedUpdatedAt) {
      await tx.agentOperation.updateMany({
        where: {
          id: operationId,
          workspaceId,
          status: "EXECUTING",
          updatedAt: params.expectedUpdatedAt,
        },
        data,
      })
      const operation = await tx.agentOperation.findFirst({
        where: { id: operationId, workspaceId },
      })
      if (!operation) throw new Error("Agent operation not found")
      return operation
    }
    return tx.agentOperation.update({ where: { id: operationId }, data })
  })
}

/**
 * Retry a failed or abandoned hosted scan cancellation after its caller has
 * verified the scan is still active. The conditional update makes retries
 * single-writer; other failed or external operations stay final.
 */
export async function retryScanCancellation(
  operationId: string,
  workspaceId: string,
  staleBefore: Date
): Promise<ClaimOperationResult | null> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const claimed = await tx.agentOperation.updateMany({
      where: {
        id: operationId,
        workspaceId,
        operationName: "scan.cancel",
        OR: [
          {
            status: "FAILED",
            error: {
              in: [
                "TASK_CANCELLATION_FAILED",
                "TASK_CANCELLATION_NOT_CONFIRMED",
                "TASK_CANCELLATION_STATUS_UNAVAILABLE",
              ],
            },
          },
          {
            status: { in: ["PENDING", "EXECUTING"] },
            error: null,
            updatedAt: { lt: staleBefore },
          },
        ],
      },
      data: { status: "EXECUTING", error: null },
    })
    const operation = await tx.agentOperation.findFirst({
      where: { id: operationId, workspaceId, operationName: "scan.cancel" },
    })
    if (!operation) return null
    if (claimed.count === 1) return { status: "NEW", operation }
    if (operation.status === "COMPLETED") return { status: "REPLAY", operation }
    if (operation.status === "FAILED" || operation.status === "CONFLICT") {
      return { status: "FAILED", operation }
    }
    return { status: "IN_PROGRESS", operation }
  })
}

export async function getAgentOperation(
  operationId: string,
  workspaceId: string
): Promise<AgentOperation | null> {
  return withWorkspaceRLS(workspaceId, (tx) =>
    tx.agentOperation.findFirst({ where: { id: operationId, workspaceId } })
  )
}

export interface AgentOperationListItem {
  id: string
  operationName: string
  status: string
  idempotencyKey: string
  connectionId: string | null
  resultReference: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Recent operations for a workspace, newest first. Bounded for presentation;
 * every row stays workspace-scoped under RLS. Used by the operation-activity
 * destination (W1-09) and the shared operation-status contract (W3-08).
 */
export async function listRecentAgentOperations(
  workspaceId: string,
  limit = 20
): Promise<AgentOperationListItem[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 50))
  const rows = await withWorkspaceRLS(workspaceId, (tx) =>
    tx.agentOperation.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: boundedLimit,
      select: {
        id: true,
        operationName: true,
        status: true,
        idempotencyKey: true,
        connectionId: true,
        resultReference: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  )
  return rows.map((row) => ({
    id: row.id,
    operationName: row.operationName,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    connectionId: row.connectionId,
    resultReference: row.resultReference,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }))
}

/**
 * Principal-bound, keyset-paginated operation listing used by the MCP task
 * surface: a task id encodes an operation id, and tasks/list must only ever
 * return operations the calling principal created — never another
 * principal's, even inside the same workspace. Rows are returned newest
 * first; `cursor` is the previous page's last operation id.
 */
export async function listAgentOperationsForTasks(params: {
  workspaceId: string
  principalType: "OAUTH_CONNECTION" | "API_KEY" | "BROWSER_SESSION"
  principalId: string
  operationName: string
  cursor?: string
  limit?: number
}): Promise<AgentOperation[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 20, 50))
  return withWorkspaceRLS(params.workspaceId, (tx) =>
    tx.agentOperation.findMany({
      where: {
        workspaceId: params.workspaceId,
        principalType: params.principalType,
        principalId: params.principalId,
        operationName: params.operationName,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    })
  )
}

export type OperationStatusState = "PENDING" | "EXECUTING" | "COMPLETED" | "FAILED" | "CONFLICT"

export interface OperationStatusView {
  /** Stable operation identity, safe to share with the principal. */
  operationId: string
  status: OperationStatusState
  /** Safe reason code; never raw provider or internal error text. */
  reasonCode: string | null
  /** Where the durable result lives (e.g. a scan id), when completed. */
  resultLocation: string | null
  /** The one recovery action this state permits. */
  recovery: "wait" | "poll" | "retry_new_key" | "none"
  createdAt: string
  updatedAt: string
}

/**
 * One operation-status/recovery contract (W3-08) shared by the dashboard,
 * CLI, MCP, and WebMCP. The error text is never echoed: callers render the
 * reason code, and an authentication failure cannot fall back to another
 * principal's operation because every lookup is workspace- and
 * principal-scoped.
 */
export async function getOperationStatus(
  operationId: string,
  workspaceId: string,
  principal: PrincipalIdentity
): Promise<OperationStatusView | null> {
  const operation = await getAgentOperation(operationId, workspaceId)
  if (
    !operation ||
    operation.principalType !== principal.principalType ||
    operation.principalId !== principal.principalId ||
    (principal.authorizationVersion !== undefined &&
      operation.authorizationVersion !== principal.authorizationVersion)
  )
    return null
  return toOperationStatusView(operation)
}

/** Pure state→recovery mapping, unit-testable without a database. */
export function toOperationStatusView(operation: AgentOperation): OperationStatusView {
  const recovery: OperationStatusView["recovery"] =
    operation.status === "COMPLETED"
      ? "none"
      : operation.status === "EXECUTING" || operation.status === "PENDING"
        ? "poll"
        : operation.status === "FAILED" && operation.error === "OPERATION_NOT_SUBMITTED"
          ? "retry_new_key"
          : "wait"
  return {
    operationId: operation.id,
    status: operation.status,
    reasonCode: operation.error ? "OPERATION_FAILED" : null,
    resultLocation: operation.resultReference,
    recovery,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
  }
}
