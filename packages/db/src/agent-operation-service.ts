import type { AgentOperation, Prisma } from "./generated/prisma"
import { logger } from "@lyrashield/logger"
import { createHash } from "node:crypto"
import { withWorkspaceRLS } from "./rls"

export interface ClaimAgentOperationParams {
  workspaceId: string
  operationName: string
  idempotencyKey: string
  input: Record<string, unknown>
  authorizationVersion?: number
  /** OAuth connection principal. Mutually exclusive with apiKeyId/userId. */
  connectionId?: string
  /** API-key principal identity (the key id). */
  apiKeyId?: string
  /** Browser-session principal id (the user id). */
  userId?: string
}

export type PrincipalIdentity = {
  principalType: "OAUTH_CONNECTION" | "API_KEY" | "BROWSER_SESSION"
  principalId: string
  connectionId?: string
}

/**
 * Resolve the principal-bound identity for an operation claim (W3-01). An
 * OAuth connection keeps its connection-bound identity; an API key or browser
 * session is never fabricated into a connection.
 */
export function resolveOperationPrincipal(
  params: Pick<ClaimAgentOperationParams, "connectionId" | "apiKeyId" | "userId">
): PrincipalIdentity {
  if (params.connectionId) {
    return { principalType: "OAUTH_CONNECTION", principalId: params.connectionId, connectionId: params.connectionId }
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

export function hashOperationInput(operationName: string, input: Record<string, unknown>): string {
  const canonical = JSON.stringify({ operationName, input }, sortKeysReplacer)
  return createHash("sha256").update(canonical).digest("hex")
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k]
    }
    return sorted
  }
  return value
}

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
    result?: Record<string, unknown>
  }
): Promise<AgentOperation> {
  return withWorkspaceRLS(workspaceId, (tx) =>
    tx.agentOperation.update({
      where: { id: operationId },
      data: {
        status: "COMPLETED",
        resultReference: params.resultReference,
        result: params.result as Prisma.InputJsonValue,
      },
    })
  )
}

export async function failAgentOperation(
  operationId: string,
  workspaceId: string,
  params: { error: string }
): Promise<AgentOperation> {
  return withWorkspaceRLS(workspaceId, (tx) =>
    tx.agentOperation.update({
      where: { id: operationId },
      data: {
        status: "FAILED",
        error: params.error,
      },
    })
  )
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
