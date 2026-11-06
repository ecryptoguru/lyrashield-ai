import { withCookieMutation } from "../../../../lib/api-auth"
import {
  getFinding,
  getFindingReference,
  withDelegatedReadAuthority,
  updateFindingStatus,
  markFalsePositive,
  acceptRisk,
  validateFindingScope,
} from "@lyrashield/db"
import {
  CLAIM_OBSERVATION_PREFIX,
  claimObservationPrefix,
  prisma,
  verifyStoredManifestChecksum,
} from "@lyrashield/db"
import { PatchFindingSchema } from "@lyrashield/types"
import { readEncryptedArtifact } from "@lyrashield/evidence-storage"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS, type Permission } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { explainFinding } from "@/lib/plain-language"
import { z } from "zod"
import { revalidateDashboardAggregates } from "../../../../lib/cache"
import {
  delegatedReadPrincipal,
  resolveDelegatedTargetReadScope,
} from "../../../../lib/delegated-target-read-scope"

const AdvisoryCvssSchema = z
  .object({
    score: z.number().finite().min(0).max(10),
    vector: z.string().max(256).optional(),
    source: z.string().max(256).optional(),
    metric_reasoning: z.string().max(8_000).optional(),
  })
  .strip()

const FindingDetailScopeSchema = z.object({
  targetId: z.string().min(1).optional(),
  observedInScanId: z.string().min(1).optional(),
})

/**
 * Allowlisted projection of a finding's `claim_context` evidence artifact.
 * Every field is engine-declared — confidence, counterevidence, advisory
 * severity, and the engine's own verification claim are evidence about what
 * the engine asserted, never the app's verification state. Reads stay inside
 * the workspace boundary (Evidence rows join through Finding.workspaceId) and
 * the decrypted payload is re-projected field-by-field so nothing unvetted
 * (storage URIs, raw blob keys) reaches the response.
 */
async function loadEvidenceInsights(
  findingId: string,
  workspaceId: string,
  originScanId: string,
  observedInScanId?: string,
  client?: Parameters<typeof getFinding>[3]
) {
  const db = client ?? prisma
  // Candidate creation is the durable observation timestamp; use an explicit
  // tie-breaker and never infer recency from the origin finding's scan id.
  const latestObservation = observedInScanId
    ? null
    : await db.findingCandidate.findFirst({
        where: {
          findingId,
          workspaceId,
          finding: { workspaceId },
          scan: { workspaceId, deletedAt: null },
        },
        select: { scanId: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })
  const selectedScanId = observedInScanId ?? latestObservation?.scanId ?? originScanId
  const allowLegacy = !observedInScanId && selectedScanId === originScanId
  const latestContext = async (id: { startsWith: string } | { not: { startsWith: string } }) => {
    const [row] = await db.evidence.findMany({
      where: { findingId, id, type: "claim_context", finding: { workspaceId } },
      select: { storageUri: true, redactionStatus: true, checksum: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 1,
    })
    return row
  }
  const boundRow = await latestContext({
    startsWith: claimObservationPrefix(findingId, selectedScanId),
  })
  const row =
    boundRow ??
    (allowLegacy
      ? await latestContext({ not: { startsWith: CLAIM_OBSERVATION_PREFIX } })
      : undefined)
  if (!row?.storageUri || row.redactionStatus === "deleted") return null
  let parsed: Record<string, unknown>
  try {
    const artifact = await readEncryptedArtifact(row.storageUri, workspaceId)
    if ((boundRow || row.checksum) && (!row.checksum || row.checksum !== artifact.checksum))
      return null
    const value = JSON.parse(artifact.content.toString("utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    parsed = value
  } catch {
    return null
  }
  const scanBound = !!boundRow
  if (
    scanBound
      ? parsed.sourceScanId !== selectedScanId || parsed.sourceFindingId !== findingId
      : parsed.sourceScanId !== undefined || parsed.sourceFindingId !== undefined
  )
    return null
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
  const idList = z.array(z.string().regex(/^[0-9]{1,128}$/)).max(10)
  const pending = idList.safeParse(parsed.pendingHttpExchangeIds)
  const pendingIds = scanBound && pending.success ? [...new Set(pending.data)] : undefined
  const captured = idList.safeParse(parsed.httpExchangeIds)
  let capturedIds: string[] | undefined
  if (
    scanBound &&
    parsed.evidenceContractVersion === "1.2" &&
    captured.success &&
    captured.data.length &&
    typeof parsed.httpExchangeArtifactChecksum === "string" &&
    /^[a-f0-9]{64}$/.test(parsed.httpExchangeArtifactChecksum) &&
    (parsed.pendingHttpExchangeIds === undefined || pending.success)
  ) {
    const stored = await db.scanResultManifest.findFirst({
      where: { scanId: selectedScanId, scan: { workspaceId, deletedAt: null } },
      select: { manifest: true, checksum: true, checksumInput: true },
    })
    const link = z
      .object({
        httpExchangeEvidence: z.object({
          checksum: z.string(),
          exchangeCount: z.number().int().positive(),
        }),
      })
      .safeParse(stored?.manifest)
    if (
      link.success &&
      verifyStoredManifestChecksum(stored) === "MATCH" &&
      link.data.httpExchangeEvidence.checksum === parsed.httpExchangeArtifactChecksum
    ) {
      capturedIds = [...new Set(captured.data)].filter((id) => !pendingIds?.includes(id))
    }
  }
  const insights = {
    capturedHttpExchangeIds: capturedIds?.length ? capturedIds : undefined,
    pendingHttpExchangeIds: pendingIds?.length ? pendingIds : undefined,
    // Recompute the state from the bounded claim; never trust a stored upgrade.
    pendingHttpExchangeState: pendingIds?.length ? ("PENDING" as const) : undefined,
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
  return Object.values(insights).some((v) => v !== undefined)
    ? {
        ...insights,
        evidenceObservationScanId: scanBound ? selectedScanId : undefined,
        legacyEvidenceContext: scanBound ? undefined : (true as const),
      }
    : null
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    const parsedScope = FindingDetailScopeSchema.safeParse({
      ...(searchParams.has("targetId") ? { targetId: searchParams.get("targetId") } : {}),
      ...(searchParams.has("observedInScanId")
        ? { observedInScanId: searchParams.get("observedInScanId") }
        : {}),
    })
    if (!parsedScope.success) {
      return apiError("INVALID_PARAM", "Invalid finding scope", 400)
    }

    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.finding.view)
    const principal = delegatedReadPrincipal(session, workspace)
    const load = async (
      client?: Parameters<typeof getFinding>[3],
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
        : await resolveDelegatedTargetReadScope(session, workspace, parsedScope.data.targetId)

      const scope = client
        ? await validateFindingScope({ workspaceId, ...parsedScope.data, ...readScope }, client)
        : await validateFindingScope({ workspaceId, ...parsedScope.data, ...readScope })
      if (!scope.available) {
        return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
      }

      const findingScope = { ...parsedScope.data, ...readScope }
      const finding = client
        ? await getFinding(id, workspaceId, findingScope, client)
        : await getFinding(id, workspaceId, findingScope)
      if (!finding) {
        return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
      }
      if (principal && !finding.targetId) {
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
      const loadInsights = (activeClient?: Parameters<typeof getFinding>[3]) =>
        loadEvidenceInsights(
          finding.id,
          workspaceId,
          finding.scanId,
          parsedScope.data.observedInScanId,
          activeClient
        )
      const evidenceInsights = client ? await loadInsights(client) : await loadInsights()

      return apiSuccess({ ...finding, evidence: safeEvidence, evidenceInsights, plainLanguage })
    }

    if (principal) {
      return await withDelegatedReadAuthority(
        {
          ...principal,
          ...(parsedScope.data.targetId ? { targetId: parsedScope.data.targetId } : {}),
        },
        (tx, authority) => load(tx, authority)
      )
    }
    return await load()
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
