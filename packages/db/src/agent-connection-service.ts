import type { AgentConnection, AgentConnectionStatus } from "./generated/prisma"
import { logger } from "@lyrashield/logger"
import { withWorkspaceRLS } from "./rls"

export interface CreateAgentConnectionParams {
  workspaceId: string
  userId: string
  clientType: string
  clientName?: string
  oauthClientId?: string
  scopes?: string[]
  allowedTargetIds?: string[]
  allTargets?: boolean
  allowedOperations?: string[]
  allowedProfiles?: string[]
  authorizationVersion?: number
  expiresAt?: Date
}

export interface AgentConnectionDTO {
  id: string
  workspaceId: string
  userId: string
  clientType: string
  clientName: string | null
  oauthClientId: string | null
  status: AgentConnectionStatus
  scopes: string[]
  allowedTargetIds: string[]
  allTargets: boolean
  allowedOperations: string[]
  allowedProfiles: string[]
  authorizationVersion: number
  expiresAt: Date | null
  revokedAt: Date | null
  pausedAt: Date | null
  createdAt: Date
  updatedAt: Date
  lastSuccessfulOperationAt?: Date | null
}

export function toAgentConnectionDTO(connection: AgentConnection): AgentConnectionDTO {
  return {
    id: connection.id,
    workspaceId: connection.workspaceId,
    userId: connection.userId,
    clientType: connection.clientType,
    clientName: connection.clientName,
    oauthClientId: connection.oauthClientId,
    status: connection.status,
    scopes: connection.scopes,
    allowedTargetIds: connection.allowedTargetIds,
    allTargets: connection.allTargets,
    allowedOperations: connection.allowedOperations,
    allowedProfiles: connection.allowedProfiles,
    authorizationVersion: connection.authorizationVersion,
    expiresAt: connection.expiresAt,
    revokedAt: connection.revokedAt,
    pausedAt: connection.pausedAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  }
}

export async function createAgentConnection(
  params: CreateAgentConnectionParams
): Promise<AgentConnectionDTO> {
  const connection = await withWorkspaceRLS(params.workspaceId, (tx) =>
    tx.agentConnection.create({
      data: {
        workspaceId: params.workspaceId,
        userId: params.userId,
        clientType: params.clientType,
        clientName: params.clientName,
        oauthClientId: params.oauthClientId,
        scopes: params.scopes ?? [],
        allowedTargetIds: params.allowedTargetIds ?? [],
        allTargets: params.allTargets ?? false,
        allowedOperations: params.allowedOperations ?? [],
        allowedProfiles: params.allowedProfiles ?? [],
        authorizationVersion: params.authorizationVersion ?? 1,
        expiresAt: params.expiresAt,
        status: "ACTIVE",
      },
    })
  )

  logger.info("Agent connection created", {
    connectionId: connection.id,
    workspaceId: connection.workspaceId,
    clientType: connection.clientType,
  })

  return toAgentConnectionDTO(connection)
}

export async function getAgentConnection(
  id: string,
  workspaceId: string
): Promise<AgentConnectionDTO | null> {
  const connection = await withWorkspaceRLS(workspaceId, (tx) =>
    tx.agentConnection.findFirst({ where: { id, workspaceId } })
  )
  return connection ? toAgentConnectionDTO(connection) : null
}

export async function listAgentConnections(
  workspaceId: string,
  options: { status?: AgentConnectionStatus } = {}
): Promise<AgentConnectionDTO[]> {
  const connections = await withWorkspaceRLS(workspaceId, (tx) =>
    tx.agentConnection.findMany({
      where: {
        workspaceId,
        ...(options.status ? { status: options.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: {
        operations: {
          where: { status: "COMPLETED" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { updatedAt: true },
        },
      },
    })
  )
  return connections.map((connection) => ({
    ...toAgentConnectionDTO(connection),
    lastSuccessfulOperationAt: connection.operations?.[0]?.updatedAt ?? null,
  }))
}

export async function pauseAgentConnection(
  id: string,
  workspaceId: string
): Promise<AgentConnectionDTO | null> {
  const updated = await withWorkspaceRLS(workspaceId, async (tx) => {
    const result = await tx.agentConnection.updateMany({
      where: { id, workspaceId, status: { in: ["ACTIVE", "PAUSED"] } },
      data: { status: "PAUSED", pausedAt: new Date() },
    })
    if (result.count === 0) return null
    return tx.agentConnection.findUnique({ where: { id } })
  })
  if (!updated) return null

  logger.info("Agent connection paused", { connectionId: id, workspaceId })
  return toAgentConnectionDTO(updated)
}

export async function resumeAgentConnection(
  id: string,
  workspaceId: string
): Promise<AgentConnectionDTO | null> {
  const updated = await withWorkspaceRLS(workspaceId, async (tx) => {
    const result = await tx.agentConnection.updateMany({
      where: { id, workspaceId, status: "PAUSED" },
      data: { status: "ACTIVE", pausedAt: null },
    })
    if (result.count === 0) return null
    return tx.agentConnection.findUnique({ where: { id } })
  })
  if (!updated) return null

  logger.info("Agent connection resumed", { connectionId: id, workspaceId })
  return toAgentConnectionDTO(updated)
}

export async function revokeAgentConnection(
  id: string,
  workspaceId: string
): Promise<AgentConnectionDTO | null> {
  const updated = await withWorkspaceRLS(workspaceId, async (tx) => {
    const result = await tx.agentConnection.updateMany({
      where: { id, workspaceId, status: { in: ["ACTIVE", "PAUSED"] } },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        authorizationVersion: { increment: 1 },
      },
    })
    if (result.count === 0) {
      return tx.agentConnection.findFirst({ where: { id, workspaceId, status: "REVOKED" } })
    }
    return tx.agentConnection.findUnique({ where: { id } })
  })
  if (!updated) return null

  logger.info("Agent connection revoked", { connectionId: id, workspaceId })
  return toAgentConnectionDTO(updated)
}
