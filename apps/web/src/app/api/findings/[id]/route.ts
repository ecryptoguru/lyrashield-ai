import { getFinding, updateFindingStatus, markFalsePositive, acceptRisk } from "@lyrashield/db"
import { prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { explainFinding } from "@/lib/plain-language"
import { z } from "zod"

const VALID_STATUSES = ["OPEN", "FIX_READY", "PR_OPENED", "FIXED", "FIXED_PENDING_RETEST", "ACCEPTED_RISK", "FALSE_POSITIVE", "DUPLICATE"] as const

const PatchFindingSchema = z.object({
  workspaceId: z.string().min(1),
  action: z.enum(["false_positive", "accept_risk", "update_status"]),
  status: z.enum(VALID_STATUSES).optional(),
})

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.finding.view)

    const finding = await getFinding(id, workspaceId)
    if (!finding) {
      return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
    }

    const plainLanguage = explainFinding({
      title: finding.title,
      severity: finding.severity,
      cwe: finding.cwe,
      category: finding.category,
      technicalDetail: finding.technicalDetail,
      recommendedFix: finding.recommendedFix,
    })

    return apiSuccess({ ...finding, plainLanguage })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get finding", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get finding", 500)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const body = await request.json()
    const parsed = PatchFindingSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, action } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.finding.view)

    const finding = await getFinding(id, workspaceId)
    if (!finding) {
      return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
    }

    switch (action) {
      case "false_positive": {
        await requirePermission(workspaceId, PERMISSIONS.finding.falsePositive)
        const updated = await markFalsePositive(id, workspaceId)
        await prisma.auditLog.create({
          data: {
            workspaceId,
            actorUserId: session.userId,
            action: "finding.false_positive",
            resourceType: "finding",
            resourceId: id,
          },
        })
        return apiSuccess({ id: updated.id, status: updated.status })
      }
      case "accept_risk": {
        await requirePermission(workspaceId, PERMISSIONS.finding.acceptRisk)
        const updated = await acceptRisk(id, workspaceId)
        await prisma.auditLog.create({
          data: {
            workspaceId,
            actorUserId: session.userId,
            action: "finding.accept_risk",
            resourceType: "finding",
            resourceId: id,
          },
        })
        return apiSuccess({ id: updated.id, status: updated.status })
      }
      case "update_status": {
        await requirePermission(workspaceId, PERMISSIONS.finding.update)
        const status = parsed.data.status
        if (!status) {
          return apiError("MISSING_PARAM", "status is required for update_status action", 400)
        }
        const updated = await updateFindingStatus(id, workspaceId, status)
        await prisma.auditLog.create({
          data: {
            workspaceId,
            actorUserId: session.userId,
            action: "finding.status_updated",
            resourceType: "finding",
            resourceId: id,
          },
        })
        return apiSuccess({ id: updated.id, status: updated.status })
      }
      default:
        return apiError("INVALID_ACTION", `Unknown action: ${action}`, 400)
    }
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to update finding", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to update finding", 500)
  }
}
