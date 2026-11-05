import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  getFindingHistoryPage,
  validateFindingScope,
  withDelegatedReadAuthority,
} from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import {
  delegatedReadPrincipal,
  resolveDelegatedTargetReadScope,
} from "../../../../../lib/delegated-target-read-scope"

const HistoryQuerySchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1).optional(),
  observedInScanId: z.string().min(1).optional(),
  collection: z.enum(["evidence", "verificationReceipts", "fixProposals", "retests"]),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const parsed = HistoryQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries())
    )
    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, targetId, observedInScanId, collection, cursor, limit } = parsed.data
    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.finding.view)
    const principal = delegatedReadPrincipal(session, workspace)
    const load = async (
      client?: Parameters<typeof getFindingHistoryPage>[4],
      authority?: {
        targetId?: string
        targetIds?: string[]
        allowedProfiles: string[]
      }
    ) => {
      const readScope = authority
        ? {
            ...(authority.targetId ? { targetId: authority.targetId } : {}),
            ...(authority.targetIds !== undefined ? { targetIds: authority.targetIds } : {}),
            allowedProfiles: authority.allowedProfiles,
            requireActiveTarget: true,
          }
        : await resolveDelegatedTargetReadScope(session, workspace, targetId)

      const scopeInput = {
        workspaceId,
        ...readScope,
        ...(observedInScanId ? { observedInScanId } : {}),
      }
      const scope = client
        ? await validateFindingScope(scopeInput, client)
        : await validateFindingScope(scopeInput)
      if (!scope.available) {
        return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
      }

      const historyOptions = {
        cursor,
        limit,
        ...readScope,
        ...(observedInScanId ? { observedInScanId } : {}),
      }
      const page = client
        ? await getFindingHistoryPage(id, workspaceId, collection, historyOptions, client)
        : await getFindingHistoryPage(id, workspaceId, collection, historyOptions)
      return apiSuccess(page)
    }

    if (principal) {
      return await withDelegatedReadAuthority(
        { ...principal, ...(targetId ? { targetId } : {}) },
        (tx, authority) => load(tx, authority)
      )
    }
    return await load()
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof Error && error.message === "Finding not found") {
      return apiError("FINDING_NOT_FOUND", error.message, 404)
    }
    if (error instanceof Error && error.message === "Invalid finding history cursor") {
      return apiError("INVALID_CURSOR", error.message, 400)
    }
    logger.error("Failed to get finding history", { findingId: id, error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get finding history", 500)
  }
}
