import type { AgentOperation } from "./generated/prisma"
import type { OperationStatusState, OperationStatusView } from "./operation-status-projection"
import { projectOperationStatus } from "./operation-status-projection"
import { withWorkspaceRLS } from "./rls"

export type DelegatedOperationDisclosure = "FULL" | "STATUS_ONLY"

export interface DelegatedOperationProjectionRow {
  id: string
  status: OperationStatusState
  error: string | null
  failedResult: boolean
  provenanceTrustworthy: boolean
  scanId: string | null
  targetDeleted: boolean
  scanDeleted: boolean
  createdAt: Date
  updatedAt: Date
}

export interface DelegatedOperationAccessRow extends DelegatedOperationProjectionRow {
  workspaceId: string
  connectionId: string | null
  operationName: string
  idempotencyKey: string
  inputHash: string
  principalType: AgentOperation["principalType"]
  principalId: string
  authorizationVersion: number
  resultReference: string | null
  result: AgentOperation["result"]
  admissionProofHash: string | null
}

export interface DelegatedOperationAccess {
  operation: AgentOperation
  status: OperationStatusView
  disclosure: DelegatedOperationDisclosure
}

export type DelegatedOperationStatusRow = DelegatedOperationProjectionRow

export function projectDelegatedOperationAccess(row: DelegatedOperationProjectionRow): {
  status: OperationStatusView
  disclosure: DelegatedOperationDisclosure
} {
  const protectedLifecycle = row.targetDeleted || row.scanDeleted || !row.scanId
  const fullDisclosure = row.provenanceTrustworthy && !protectedLifecycle
  return {
    status: projectOperationStatus({
      id: row.id,
      status: row.status,
      error: row.error,
      failedResult: row.failedResult,
      resultLocation: row.provenanceTrustworthy ? row.scanId : null,
      allowRecoveryDetails: fullDisclosure,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    disclosure: fullDisclosure ? "FULL" : "STATUS_ONLY",
  }
}

export function projectDelegatedOperationStatus(
  row: DelegatedOperationProjectionRow
): OperationStatusView {
  return projectDelegatedOperationAccess(row).status
}

async function readDelegatedOperationAccess(params: {
  operationId: string
  workspaceId: string
  userId: string
  memberId: string
  memberRole: string
  memberUpdatedAt: Date
  connectionId: string
  authorizationVersion: number
}): Promise<DelegatedOperationAccessRow | null> {
  const rows = await withWorkspaceRLS(
    params.workspaceId,
    (tx) =>
      tx.$queryRaw<DelegatedOperationAccessRow[]>`
      SELECT
        o.id,
        o."workspaceId",
        o."connectionId",
        o."operationName",
        o."idempotencyKey",
        o."inputHash",
        o."principalType",
        o."principalId",
        o."authorizationVersion",
        o.status::text AS "status",
        o."resultReference",
        o.result,
        o.error,
        o."admissionProofHash",
        CASE
          WHEN jsonb_typeof(o.result) = 'object' AND o.result->>'isError' = 'true' THEN true
          ELSE false
        END AS "failedResult",
        (
          p."operationId" IS NOT NULL
          AND o."resultReference" = p."scanId"
          AND o."inputHash" = p."operationInputHash"
          AND s.id = p."scanId"
          AND s."workspaceId" = p."workspaceId"
          AND s."targetId" = p."targetId"
          AND s."executionPlanHash" = p."scanExecutionPlanHash"
          AND s."delegatedConnectionId" = p."connectionId"
          AND s."delegatedAuthorizationVersion" = p."authorizationVersion"
          AND t.id = p."targetId"
          AND t."workspaceId" = p."workspaceId"
          AND p."connectionId" = c.id
          AND p."authorizationVersion" = c."authorizationVersion"
        ) AS "provenanceTrustworthy",
        s.id AS "scanId",
        COALESCE(t."deletedAt" IS NOT NULL, false) AS "targetDeleted",
        COALESCE(s."deletedAt" IS NOT NULL, false) AS "scanDeleted",
        o."createdAt",
        o."updatedAt"
      FROM "agent_operations" o
      JOIN "agent_connections" c
        ON c.id = o."connectionId" AND c."workspaceId" = o."workspaceId"
      JOIN "WorkspaceMember" m
        ON m.id = ${params.memberId}
       AND m."workspaceId" = ${params.workspaceId}
       AND m."userId" = ${params.userId}
      LEFT JOIN "delegated_scan_provenance" p ON p."operationId" = o.id
      LEFT JOIN "Scan" s ON s.id = p."scanId"
      LEFT JOIN "Target" t ON t.id = p."targetId"
      WHERE o.id = ${params.operationId}
        AND o."workspaceId" = ${params.workspaceId}
        AND o."connectionId" = ${params.connectionId}
        AND o."principalType" = 'OAUTH_CONNECTION'
        AND o."principalId" = ${params.connectionId}
        AND o."authorizationVersion" = ${params.authorizationVersion}
        AND c.id = ${params.connectionId}
        AND c."userId" = ${params.userId}
        AND c.status = 'ACTIVE'
        AND c."authorizationVersion" = ${params.authorizationVersion}
        AND (c."expiresAt" IS NULL OR c."expiresAt" > (statement_timestamp() AT TIME ZONE 'UTC'))
        AND c.scopes && ARRAY['lyrashield.read', 'lyrashield.write']::text[]
        AND m.status = 'active'
        AND m.role = ${params.memberRole}::"MemberRole"
        AND m."updatedAt" = ${params.memberUpdatedAt}
        AND (
          p."operationId" IS NULL
          OR (
            c."allowedOperations" @> ARRAY[o."operationName"]::text[]
            AND (c."allTargets" OR s."targetId" = ANY(c."allowedTargetIds"))
            AND EXISTS (
              SELECT 1
              FROM unnest(c."allowedProfiles") AS allowed(profile)
              WHERE upper(allowed.profile) = upper(s.mode::text)
            )
          )
        )
      LIMIT 1
    `
  )
  return rows[0] ?? null
}

export async function getDelegatedOperationAccess(
  params: Parameters<typeof readDelegatedOperationAccess>[0]
): Promise<DelegatedOperationAccess | null> {
  const row = await readDelegatedOperationAccess(params)
  if (!row) return null
  const { status, disclosure } = projectDelegatedOperationAccess(row)
  return {
    operation: {
      id: row.id,
      workspaceId: row.workspaceId,
      connectionId: row.connectionId,
      operationName: row.operationName,
      idempotencyKey: row.idempotencyKey,
      inputHash: row.inputHash,
      principalType: row.principalType,
      principalId: row.principalId,
      authorizationVersion: row.authorizationVersion,
      status: row.status,
      resultReference: row.resultReference,
      result: row.result,
      error: row.error,
      admissionProofHash: row.admissionProofHash,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    status,
    disclosure,
  }
}

export async function getDelegatedOperationStatus(
  params: Parameters<typeof readDelegatedOperationAccess>[0]
): Promise<OperationStatusView | null> {
  return (await getDelegatedOperationAccess(params))?.status ?? null
}
