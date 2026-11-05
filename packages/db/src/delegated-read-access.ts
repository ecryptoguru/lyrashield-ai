import { withWorkspaceRLS, type ScopedTransaction } from "./rls"
import type { ScanStatus } from "./generated/prisma"
import { lockWorkspaceScanAdmission } from "./scan-slot"

export interface DelegatedReadPrincipal {
  workspaceId: string
  userId: string
  memberId: string
  memberRole: string
  memberUpdatedAt: Date
  connectionId: string
  authorizationVersion: number
}

export interface DelegatedScanAccess {
  /** Only trustworthy delegated provenance may expose the scan identifier. */
  scanId: string | null
  status: ScanStatus
  statusOnly: boolean
}

export interface DelegatedScanListAccess extends DelegatedScanAccess {
  /** Untrusted source id used only for server-side list correlation, never serialized. */
  sourceId: string
}

export async function getDelegatedActiveTargetIds(
  params: DelegatedReadPrincipal & { targetId?: string }
): Promise<string[] | null> {
  const rows = await withWorkspaceRLS(
    params.workspaceId,
    (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
      SELECT t.id
      FROM "Target" t
      JOIN "agent_connections" c
        ON c.id = ${params.connectionId} AND c."workspaceId" = t."workspaceId"
      JOIN "WorkspaceMember" m
        ON m.id = ${params.memberId}
       AND m."workspaceId" = t."workspaceId"
       AND m."userId" = ${params.userId}
      WHERE t."workspaceId" = ${params.workspaceId}
        AND t."deletedAt" IS NULL
        AND (${params.targetId ?? null}::text IS NULL OR t.id = ${params.targetId ?? null})
        AND c."userId" = ${params.userId}
        AND c.status = 'ACTIVE'
        AND c."authorizationVersion" = ${params.authorizationVersion}
        AND (c."expiresAt" IS NULL OR c."expiresAt" > (statement_timestamp() AT TIME ZONE 'UTC'))
        AND c.scopes && ARRAY['lyrashield.read', 'lyrashield.write']::text[]
        AND m.status = 'active'
        AND m.role = ${params.memberRole}::"MemberRole"
        AND m."updatedAt" = ${params.memberUpdatedAt}
        AND (c."allTargets" OR t.id = ANY(c."allowedTargetIds"))
      ORDER BY t.id
    `
  )
  if (rows.length === 0 && params.targetId) return null
  return rows.map((row) => row.id)
}

export async function getDelegatedScanAccess(
  params: DelegatedReadPrincipal & { scanId: string },
  client?: ScopedTransaction
): Promise<DelegatedScanAccess | null> {
  const read = (tx: ScopedTransaction) =>
    tx.$queryRaw<
        Array<{
          id: string
          status: ScanStatus
          provenanceTrustworthy: boolean
          targetDeleted: boolean
          scanDeleted: boolean
        }>
      >`
      SELECT
        s.id,
        s.status::text AS "status",
        (
          p."operationId" IS NOT NULL
          AND s."workspaceId" = p."workspaceId"
          AND s."targetId" = p."targetId"
          AND s."executionPlanHash" = p."scanExecutionPlanHash"
          AND s."delegatedConnectionId" = p."connectionId"
          AND s."delegatedAuthorizationVersion" = p."authorizationVersion"
          AND p."connectionId" = c.id
          AND p."authorizationVersion" = c."authorizationVersion"
          AND o.id = p."operationId"
          AND o."workspaceId" = s."workspaceId"
          AND o."connectionId" = c.id
          AND o."principalType" = 'OAUTH_CONNECTION'
          AND o."principalId" = c.id
          AND o."authorizationVersion" = c."authorizationVersion"
          AND c."allowedOperations" @> ARRAY[o."operationName"]::text[]
        ) AS "provenanceTrustworthy",
        COALESCE(t."deletedAt" IS NOT NULL, false) AS "targetDeleted",
        COALESCE(s."deletedAt" IS NOT NULL, false) AS "scanDeleted"
      FROM "Scan" s
      JOIN "Target" t ON t.id = s."targetId" AND t."workspaceId" = s."workspaceId"
      JOIN "agent_connections" c
        ON c.id = ${params.connectionId} AND c."workspaceId" = s."workspaceId"
      JOIN "WorkspaceMember" m
        ON m.id = ${params.memberId}
       AND m."workspaceId" = s."workspaceId"
       AND m."userId" = ${params.userId}
      LEFT JOIN "delegated_scan_provenance" p ON p."scanId" = s.id
      LEFT JOIN "agent_operations" o ON o.id = p."operationId"
      WHERE s.id = ${params.scanId}
        AND s."workspaceId" = ${params.workspaceId}
        AND c."userId" = ${params.userId}
        AND c.status = 'ACTIVE'
        AND c."authorizationVersion" = ${params.authorizationVersion}
        AND s."delegatedConnectionId" = c.id
        AND s."delegatedAuthorizationVersion" = c."authorizationVersion"
        AND (c."expiresAt" IS NULL OR c."expiresAt" > (statement_timestamp() AT TIME ZONE 'UTC'))
        AND c.scopes && ARRAY['lyrashield.read', 'lyrashield.write']::text[]
        AND (
          p."operationId" IS NULL
          OR c."allowedOperations" @> ARRAY[o."operationName"]::text[]
        )
        AND (c."allTargets" OR t.id = ANY(c."allowedTargetIds"))
        AND EXISTS (
          SELECT 1
          FROM unnest(c."allowedProfiles") AS allowed(profile)
          WHERE upper(allowed.profile) = upper(s.mode::text)
        )
        AND m.status = 'active'
        AND m.role = ${params.memberRole}::"MemberRole"
        AND m."updatedAt" = ${params.memberUpdatedAt}
        LIMIT 1
      `
  const rows = client
    ? await read(client)
    : await withWorkspaceRLS(params.workspaceId, read)
  const row = rows[0]
  if (!row) return null
  return {
    scanId: row.provenanceTrustworthy ? row.id : null,
    status: row.status,
    statusOnly: !row.provenanceTrustworthy || row.targetDeleted || row.scanDeleted,
  }
}

export async function getDelegatedScanAccessBatch(
  params: DelegatedReadPrincipal & { scanIds: string[] },
  client?: ScopedTransaction
): Promise<DelegatedScanListAccess[]> {
  if (params.scanIds.length === 0) return []
  if (params.scanIds.length > 100 || new Set(params.scanIds).size !== params.scanIds.length) {
    throw new Error("Invalid delegated scan list")
  }
  const read = (tx: ScopedTransaction) =>
    tx.$queryRaw<
        Array<{
          id: string
          status: ScanStatus
          provenanceTrustworthy: boolean
          targetDeleted: boolean
          scanDeleted: boolean
        }>
      >`
      SELECT
        s.id,
        s.status::text AS "status",
        (
          p."operationId" IS NOT NULL
          AND s."workspaceId" = p."workspaceId"
          AND s."targetId" = p."targetId"
          AND s."executionPlanHash" = p."scanExecutionPlanHash"
          AND s."delegatedConnectionId" = p."connectionId"
          AND s."delegatedAuthorizationVersion" = p."authorizationVersion"
          AND p."connectionId" = c.id
          AND p."authorizationVersion" = c."authorizationVersion"
          AND o.id = p."operationId"
          AND o."workspaceId" = s."workspaceId"
          AND o."connectionId" = c.id
          AND o."principalType" = 'OAUTH_CONNECTION'
          AND o."principalId" = c.id
          AND o."authorizationVersion" = c."authorizationVersion"
          AND c."allowedOperations" @> ARRAY[o."operationName"]::text[]
        ) AS "provenanceTrustworthy",
        COALESCE(t."deletedAt" IS NOT NULL, false) AS "targetDeleted",
        COALESCE(s."deletedAt" IS NOT NULL, false) AS "scanDeleted"
      FROM "Scan" s
      JOIN "Target" t ON t.id = s."targetId" AND t."workspaceId" = s."workspaceId"
      JOIN "agent_connections" c
        ON c.id = ${params.connectionId} AND c."workspaceId" = s."workspaceId"
      JOIN "WorkspaceMember" m
        ON m.id = ${params.memberId}
       AND m."workspaceId" = s."workspaceId"
       AND m."userId" = ${params.userId}
      LEFT JOIN "delegated_scan_provenance" p ON p."scanId" = s.id
      LEFT JOIN "agent_operations" o ON o.id = p."operationId"
      WHERE s.id = ANY(${params.scanIds}::text[])
        AND s."workspaceId" = ${params.workspaceId}
        AND c."userId" = ${params.userId}
        AND c.status = 'ACTIVE'
        AND c."authorizationVersion" = ${params.authorizationVersion}
        AND s."delegatedConnectionId" = c.id
        AND s."delegatedAuthorizationVersion" = c."authorizationVersion"
        AND (c."expiresAt" IS NULL OR c."expiresAt" > (statement_timestamp() AT TIME ZONE 'UTC'))
        AND c.scopes && ARRAY['lyrashield.read', 'lyrashield.write']::text[]
        AND (c."allTargets" OR t.id = ANY(c."allowedTargetIds"))
        AND (
          p."operationId" IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM unnest(c."allowedOperations") AS allowed(operation)
            WHERE allowed.operation = 'scan.create'
          )
        )
        AND EXISTS (
          SELECT 1
          FROM unnest(c."allowedProfiles") AS allowed(profile)
          WHERE upper(allowed.profile) = upper(s.mode::text)
        )
        AND m.status = 'active'
        AND m.role = ${params.memberRole}::"MemberRole"
        AND m."updatedAt" = ${params.memberUpdatedAt}
        ORDER BY s.id
      `
  const rows = client
    ? await read(client)
    : await withWorkspaceRLS(params.workspaceId, read)
  return rows.map((row) => ({
    sourceId: row.id,
    scanId: row.provenanceTrustworthy ? row.id : null,
    status: row.status,
    statusOnly: !row.provenanceTrustworthy || row.targetDeleted || row.scanDeleted,
  }))
}

export interface DelegatedReadAuthority {
  targetId?: string
  targetIds?: string[]
  allowedProfiles: string[]
}

export interface DelegatedReadAuthorityParams {
  /** Mutating delegated routes must prove the current canonical grant under the same lock. */
  requiredOperation?: string
  /** The selected/source scan profile must still be granted by the connection. */
  requiredProfile?: string
}

export interface DelegatedScanAuthority {
  memberRole: string
  targetId: string
  profile: string
}

/**
 * Revalidate queued delegated work against live connection, membership,
 * operation/profile grants and target lifecycle. The caller owns the RLS
 * transaction; this helper locks every authorization row for its duration.
 */
export async function getCurrentDelegatedScanAuthority(
  tx: ScopedTransaction,
  params: {
    workspaceId: string
    userId: string
    scanId: string
    targetId: string
    connectionId: string
    authorizationVersion: number
    operationName: string
    profile: string
  }
): Promise<DelegatedScanAuthority | null> {
  const [row] = await tx.$queryRaw<Array<{ memberRole: string; targetId: string }>>`
    SELECT m.role::text AS "memberRole", t.id AS "targetId"
    FROM "Scan" s
    JOIN "Target" t ON t.id = s."targetId" AND t."workspaceId" = s."workspaceId"
    JOIN "agent_connections" c
      ON c.id = ${params.connectionId} AND c."workspaceId" = s."workspaceId"
    JOIN "WorkspaceMember" m
      ON m."workspaceId" = s."workspaceId" AND m."userId" = ${params.userId}
    WHERE s.id = ${params.scanId}
      AND s."workspaceId" = ${params.workspaceId}
      AND s."targetId" = ${params.targetId}
      AND s."delegatedConnectionId" = c.id
      AND s."delegatedAuthorizationVersion" = ${params.authorizationVersion}
      AND c."userId" = ${params.userId}
      AND c.status = 'ACTIVE'
      AND c."authorizationVersion" = ${params.authorizationVersion}
      AND (c."expiresAt" IS NULL OR c."expiresAt" > clock_timestamp())
      AND c.scopes && ARRAY['lyrashield.read', 'lyrashield.write']::text[]
      AND c."allowedOperations" @> ARRAY[${params.operationName}]::text[]
      AND (c."allTargets" OR t.id = ANY(c."allowedTargetIds"))
      AND EXISTS (
        SELECT 1
        FROM unnest(c."allowedProfiles") AS allowed(profile)
        WHERE upper(allowed.profile) = upper(${params.profile})
      )
      AND m.status = 'active'
      AND t."deletedAt" IS NULL
    LIMIT 1
    FOR SHARE OF s, t, c, m
  `
  if (!row) return null
  return { memberRole: row.memberRole, targetId: row.targetId, profile: params.profile }
}

/**
 * Hold the delegate connection, membership and active target rows stable
 * while a content-bearing query runs on the same transaction. Revocation,
 * role changes, grant narrowing and target deletion must wait for this read.
 */
export async function withDelegatedReadAuthority<T>(
  params: DelegatedReadPrincipal & DelegatedReadAuthorityParams & { targetId?: string },
  run: (tx: ScopedTransaction, authority: DelegatedReadAuthority) => Promise<T>
): Promise<T> {
  return withWorkspaceRLS(params.workspaceId, async (tx) => {
    // Lock the connection and membership first. This keeps status, version,
    // scope, expiry, operation/profile grants and role stable even when the
    // workspace currently has no active targets.
    const [connection] = await tx.$queryRaw<
      Array<{ allowedProfiles: string[]; allowedOperations: string[] }>
    >`
      SELECT c."allowedProfiles", c."allowedOperations"
      FROM "agent_connections" c
      JOIN "WorkspaceMember" m
        ON m.id = ${params.memberId}
       AND m."workspaceId" = c."workspaceId"
       AND m."userId" = ${params.userId}
      WHERE c.id = ${params.connectionId}
        AND c."workspaceId" = ${params.workspaceId}
        AND c."userId" = ${params.userId}
        AND c.status = 'ACTIVE'
        AND c."authorizationVersion" = ${params.authorizationVersion}
        AND (c."expiresAt" IS NULL OR c."expiresAt" > clock_timestamp())
        AND c.scopes && ARRAY['lyrashield.read', 'lyrashield.write']::text[]
        AND m.status = 'active'
        AND m.role = ${params.memberRole}::"MemberRole"
        AND m."updatedAt" = ${params.memberUpdatedAt}
      FOR SHARE OF c, m
    `
    if (!connection) throw new Error("FORBIDDEN")
    const allowedProfiles = connection.allowedProfiles.map((profile) => profile.toUpperCase())
    if (params.requiredOperation && !connection.allowedOperations.includes(params.requiredOperation)) {
      throw new Error("FORBIDDEN")
    }
    if (
      params.requiredProfile &&
      !allowedProfiles.includes(params.requiredProfile.toUpperCase())
    ) {
      throw new Error("FORBIDDEN")
    }

    const candidateTargets = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT t.id
      FROM "Target" t
      JOIN "agent_connections" c
        ON c.id = ${params.connectionId} AND c."workspaceId" = t."workspaceId"
      WHERE t."workspaceId" = ${params.workspaceId}
        AND t."deletedAt" IS NULL
        AND (${params.targetId ?? null}::text IS NULL OR t.id = ${params.targetId ?? null})
        AND (c."allTargets" OR t.id = ANY(c."allowedTargetIds"))
      ORDER BY t.id
    `
    if (params.targetId && candidateTargets.length !== 1) throw new Error("FORBIDDEN")

    // Use the same workspace -> target advisory-lock order as scan creation,
    // target deletion and delegated derived writes. Re-read with row locks only
    // after the advisory locks are held to avoid a lock-order inversion.
    await lockWorkspaceScanAdmission(tx, params.workspaceId)
    for (const target of candidateTargets) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${target.id}))`
    }
    const targets = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT t.id
      FROM "Target" t
      JOIN "agent_connections" c
        ON c.id = ${params.connectionId} AND c."workspaceId" = t."workspaceId"
      WHERE t."workspaceId" = ${params.workspaceId}
        AND t."deletedAt" IS NULL
        AND (${params.targetId ?? null}::text IS NULL OR t.id = ${params.targetId ?? null})
        AND (c."allTargets" OR t.id = ANY(c."allowedTargetIds"))
      ORDER BY t.id
      FOR SHARE OF t
    `
    if (params.targetId && targets.length !== 1) throw new Error("FORBIDDEN")
    return run(tx, {
      ...(params.targetId
        ? { targetId: params.targetId }
        : { targetIds: targets.map((row) => row.id) }),
      allowedProfiles,
    })
  })
}
