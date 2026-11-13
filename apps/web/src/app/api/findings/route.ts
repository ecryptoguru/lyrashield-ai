import {
  listFindings,
  getFindingStats,
  validateFindingScope,
  withDelegatedReadAuthority,
} from "@lyrashield/db"
import { FindingQuerySchema } from "@lyrashield/types"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import {
  apiError,
  apiSuccess,
  apiPaginated,
  parsePaginationParams,
} from "../../../lib/api-response"
import { calculateFindingPriority } from "../../../lib/finding-priority"
import { SEVERITY_ORDER } from "../../../lib/severity-presentation"
import {
  delegatedReadPrincipal,
  resolveDelegatedTargetReadScope,
} from "../../../lib/delegated-target-read-scope"

type FindingReadClient = Parameters<typeof listFindings>[1]

async function loadFindingResponse(input: {
  client: FindingReadClient
  readScope: {
    targetId?: string
    targetIds?: string[]
    allowedProfiles?: string[]
    requireActiveTarget?: boolean
  }
  workspaceId: string
  targetId?: string
  observedInScanId?: string
  scanId?: string
  severity?: Parameters<typeof listFindings>[0]["severity"]
  status?: Parameters<typeof listFindings>[0]["status"]
  verified?: boolean | string
  category?: string
  q?: string
  stats: boolean
  cursor?: string
  limit: number
}) {
  const {
    client,
    readScope,
    workspaceId,
    targetId,
    observedInScanId,
    scanId,
    severity,
    status,
    verified,
    category,
    q,
    stats,
    cursor,
    limit,
  } = input
  const scopeInput = {
    workspaceId,
    ...readScope,
    ...(observedInScanId ? { observedInScanId } : {}),
  }
  const scope = client
    ? await validateFindingScope(scopeInput, client)
    : await validateFindingScope(scopeInput)
  if (!scope.available) {
    return apiError(
      "INVALID_PARAM",
      "Selected scan or target is unavailable in this workspace",
      400
    )
  }

  if (stats) {
    const findingStats = await getFindingStats(
      workspaceId,
      targetId,
      observedInScanId,
      readScope.targetIds,
      Boolean(readScope.requireActiveTarget),
      client,
      readScope.allowedProfiles
    )
    return apiSuccess(findingStats)
  }

  const listInput = {
    workspaceId,
    ...readScope,
    ...(observedInScanId ? { observedInScanId } : {}),
    ...(scanId ? { scanId } : {}),
    ...(severity ? { severity } : {}),
    ...(status ? { status } : {}),
    ...(verified !== undefined
      ? { verified: typeof verified === "string" ? verified === "true" : verified }
      : {}),
    ...(category ? { category } : {}),
    ...(q ? { q } : {}),
    ...(cursor ? { cursor } : {}),
    limit,
  }
  const { items, nextCursor } = client
    ? await listFindings(listInput, client)
    : await listFindings(listInput)

  const prioritized = items.map((finding) => ({
    ...finding,
    priority: calculateFindingPriority({
      severity: finding.severity,
      status: finding.status,
      verified: finding.verified,
      confidence: finding.confidence,
      environment: finding.target?.environment as
        "LOCAL" | "PREVIEW" | "STAGING" | "PRODUCTION" | null | undefined,
      businessImpact: finding.businessImpact,
      exploitability: finding.exploitability,
    }),
  }))
  prioritized.sort(
    (left, right) =>
      right.priority.score - left.priority.score ||
      (SEVERITY_ORDER[right.severity] ?? 99) - (SEVERITY_ORDER[left.severity] ?? 99) ||
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  )
  return apiPaginated(prioritized, nextCursor)
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const params = Object.fromEntries(searchParams)
    const parsed = FindingQuerySchema.safeParse(params)

    if (!parsed.success) {
      return apiError(
        "INVALID_PARAM",
        parsed.error.issues[0]?.message ?? "Invalid query parameter",
        400
      )
    }

    const {
      workspaceId,
      targetId,
      observedInScanId,
      scanId,
      severity,
      status,
      verified,
      category,
      q,
    } = parsed.data
    const stats = parsed.data.stats === "true"

    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.finding.view)
    const { cursor, limit } = parsePaginationParams(searchParams, 25)
    const principal = delegatedReadPrincipal(session, workspace)
    if (principal) {
      return await withDelegatedReadAuthority(
        { ...principal, ...(targetId ? { targetId } : {}) },
        (tx, authority) =>
          loadFindingResponse({
            client: tx,
            readScope: { ...authority, requireActiveTarget: true },
            workspaceId,
            targetId: targetId ?? undefined,
            observedInScanId: observedInScanId ?? undefined,
            scanId: scanId ?? undefined,
            severity: severity ?? undefined,
            status: status ?? undefined,
            verified,
            category: category ?? undefined,
            q: q ?? undefined,
            stats,
            cursor: cursor ?? undefined,
            limit,
          })
      )
    }
    return loadFindingResponse({
      client: undefined,
      readScope: await resolveDelegatedTargetReadScope(session, workspace, targetId),
      workspaceId,
      targetId: targetId ?? undefined,
      observedInScanId: observedInScanId ?? undefined,
      scanId: scanId ?? undefined,
      severity: severity ?? undefined,
      status: status ?? undefined,
      verified,
      category: category ?? undefined,
      q: q ?? undefined,
      stats,
      cursor: cursor ?? undefined,
      limit,
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list findings", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list findings", 500)
  }
}
