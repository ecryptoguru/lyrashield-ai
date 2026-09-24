import { withCookieMutation } from "../../../../lib/api-auth"
import {
  getFinding,
  getFindingReference,
  updateFindingStatus,
  markFalsePositive,
  acceptRisk,
} from "@lyrashield/db"
import { prisma } from "@lyrashield/db"
import { readEncryptedArtifact } from "@lyrashield/evidence-storage"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS, type Permission } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { explainFinding } from "@/lib/plain-language"
import { z } from "zod"
import { revalidateDashboardAggregates } from "../../../../lib/cache"

const VALID_STATUSES = [
  "OPEN",
  "FIX_READY",
  "PR_OPENED",
  "FIXED",
  "FIXED_PENDING_RETEST",
  "ACCEPTED_RISK",
  "FALSE_POSITIVE",
  "DUPLICATE",
] as const

const PatchFindingSchema = z
  .object({
    workspaceId: z.string().min(1),
    action: z.enum(["false_positive", "accept_risk", "update_status"]),
    status: z.enum(VALID_STATUSES).optional(),
    reason: z.string().max(1000).optional(),
    canonicalFindingId: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.action === "false_positive" || value.action === "accept_risk") &&
      !value.reason?.trim()
    ) {
      context.addIssue({ code: "custom", path: ["reason"], message: "reason is required" })
    }
  })

const AdvisoryCvssSchema = z
  .object({
    score: z.number().finite().min(0).max(10),
    vector: z.string().max(256).optional(),
    source: z.string().max(256).optional(),
    metric_reasoning: z.string().max(8_000).optional(),
  })
  .strip()

/**
 * Allowlisted projection of a finding's `claim_context` evidence artifact.
 * Every field is engine-declared — confidence, counterevidence, advisory
 * severity, and the engine's own verification claim are evidence about what
 * the engine asserted, never the app's verification state. Reads stay inside
 * the workspace boundary (Evidence rows join through Finding.workspaceId) and
 * the decrypted payload is re-projected field-by-field so nothing unvetted
 * (storage URIs, raw blob keys) reaches the response.
 */
async function loadEvidenceInsights(findingId: string, workspaceId: string) {
  const row = await prisma.evidence.findFirst({
    where: { findingId, type: "claim_context", finding: { workspaceId } },
    select: { storageUri: true },
  })
  if (!row?.storageUri) return null
  let artifact
  try {
    artifact = await readEncryptedArtifact(row.storageUri, workspaceId)
  } catch {
    return null
  }
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(artifact.content.toString("utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }
  const text = (key: string) => {
    const value = parsed[key]
    if (typeof value === "string") return value.slice(0, 64_000)
    // Pre-contract records stored lists; keep them readable as paragraphs.
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string")
        .slice(0, 25)
        .join("\n")
        .slice(0, 64_000)
    }
    return undefined
  }
  const evidenceWarnings = parsed.evidenceWarnings
  const advisory = AdvisoryCvssSchema.safeParse(
    typeof parsed.advisoryCvss === "number" ? { score: parsed.advisoryCvss } : parsed.advisoryCvss
  )
  const insights = {
    counterevidence: text("counterevidence"),
    evidenceWarnings: Array.isArray(evidenceWarnings)
      ? evidenceWarnings.filter((item): item is string => typeof item === "string").slice(0, 25)
      : undefined,
    severityChangeConditions: text("severityChangeConditions"),
    assumptions: text("assumptions"),
    confidenceRationale: text("confidenceRationale"),
    contextualCvssReasoning: text("contextualCvssReasoning"),
    advisoryCvss: advisory.success ? advisory.data : undefined,
    engineVerificationState: text("engineVerificationState"),
    engineConfidence: text("engineConfidence"),
  }
  return Object.values(insights).some((v) => v !== undefined) ? insights : null
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
      recommendedFix: finding.recommendedFix,
    })

    // Defense in depth: evidence rows must never leak their private storage
    // URI to the dashboard, even if a future service layer returns one.
    const safeEvidence = finding.evidence.map(({ id, type, redactionStatus }) => ({
      id,
      type,
      redactionStatus,
    }))

    // Engine-declared insights are allowlist-projected from the encrypted
    // claim_context artifact — private to the workspace, never part of public
    // shares or exports.
    const evidenceInsights = await loadEvidenceInsights(finding.id, workspaceId)

    return apiSuccess({ ...finding, evidence: safeEvidence, evidenceInsights, plainLanguage })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get finding", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get finding", 500)
  }
}

async function patch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const body = await request.json()
    const parsed = PatchFindingSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, action } = parsed.data

    const actionPermission: Record<string, Permission> = {
      false_positive: PERMISSIONS.finding.falsePositive,
      accept_risk: PERMISSIONS.finding.acceptRisk,
      update_status: PERMISSIONS.finding.update,
    }

    const requiredPermission = actionPermission[action]
    if (!requiredPermission) {
      return apiError("INVALID_ACTION", `Unknown action: ${action}`, 400)
    }

    const { session } = await requirePermission(workspaceId, requiredPermission)

    const finding = await getFindingReference(id, workspaceId)
    if (!finding) {
      return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
    }

    const reason = parsed.data.reason

    switch (action) {
      case "false_positive": {
        const updated = await markFalsePositive(id, workspaceId, reason, session.userId)
        await prisma.auditLog.create({
          data: {
            workspaceId,
            actorUserId: session.userId,
            action: "finding.false_positive",
            resourceType: "finding",
            resourceId: id,
          },
        })
        revalidateDashboardAggregates(workspaceId)
        return apiSuccess({ id: updated.id, status: updated.status })
      }
      case "accept_risk": {
        const updated = await acceptRisk(id, workspaceId, reason, session.userId)
        await prisma.auditLog.create({
          data: {
            workspaceId,
            actorUserId: session.userId,
            action: "finding.accept_risk",
            resourceType: "finding",
            resourceId: id,
          },
        })
        revalidateDashboardAggregates(workspaceId)
        return apiSuccess({ id: updated.id, status: updated.status })
      }
      case "update_status": {
        const status = parsed.data.status
        if (!status) {
          return apiError("MISSING_PARAM", "status is required for update_status action", 400)
        }
        const updated = await updateFindingStatus(
          id,
          workspaceId,
          status,
          reason,
          parsed.data.canonicalFindingId
        )
        await prisma.auditLog.create({
          data: {
            workspaceId,
            actorUserId: session.userId,
            action: "finding.status_updated",
            resourceType: "finding",
            resourceId: id,
          },
        })
        revalidateDashboardAggregates(workspaceId)
        return apiSuccess({ id: updated.id, status: updated.status })
      }
    }
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to update finding", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to update finding", 500)
  }
}

export const PATCH = withCookieMutation(patch)
