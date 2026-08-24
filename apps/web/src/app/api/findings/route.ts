import { listFindings, getFindingStats } from "@lyrashield/db"
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
import { z } from "zod"
import { calculateFindingPriority } from "../../../lib/finding-priority"

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
}

const FindingQuerySchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().optional(),
  scanId: z.string().optional(),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]).optional(),
  status: z
    .enum([
      "OPEN",
      "FIX_READY",
      "PR_OPENED",
      "TICKET_CREATED",
      "FIXED",
      "FIXED_PENDING_RETEST",
      "ACCEPTED_RISK",
      "FALSE_POSITIVE",
      "DUPLICATE",
    ])
    .optional(),
  verified: z.enum(["true", "false"]).optional(),
  category: z.string().optional(),
  stats: z.enum(["true"]).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
})

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

    const { workspaceId, targetId, scanId, severity, status, verified, category } = parsed.data
    const stats = parsed.data.stats === "true"

    await requirePermission(workspaceId, PERMISSIONS.finding.view)

    if (stats) {
      const findingStats = await getFindingStats(workspaceId, targetId)
      return apiSuccess(findingStats)
    }

    const { cursor, limit } = parsePaginationParams(searchParams)

    const { items, nextCursor } = await listFindings({
      workspaceId,
      ...(targetId ? { targetId } : {}),
      ...(scanId ? { scanId } : {}),
      ...(severity ? { severity } : {}),
      ...(status ? { status } : {}),
      ...(verified !== undefined ? { verified: verified === "true" } : {}),
      ...(category ? { category } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    })

    const prioritized = items.map((finding) => ({
      ...finding,
      priority: calculateFindingPriority({
        severity: finding.severity,
        status: finding.status,
        verified: finding.verified,
        confidence: finding.confidence,
        environment: finding.target?.environment as
          | "LOCAL"
          | "PREVIEW"
          | "STAGING"
          | "PRODUCTION"
          | null
          | undefined,
        businessImpact: finding.businessImpact,
        exploitability: finding.exploitability,
      }),
    }))

    // ponytail: page-local ranking only — bounded by the 100-item page
    // ceiling; persist/index a score only if workspace scale proves it
    // necessary. The database cursor below stays derived from the original
    // severity/createdAt order so pagination never duplicates or drops rows.
    prioritized.sort(
      (left, right) =>
        right.priority.score - left.priority.score ||
        (SEVERITY_ORDER[right.severity] ?? 99) - (SEVERITY_ORDER[left.severity] ?? 99) ||
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    )

    return apiPaginated(prioritized, nextCursor)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list findings", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list findings", 500)
  }
}
