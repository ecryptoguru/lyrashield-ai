import { prisma, withWorkspaceRLS, evaluateGateForTarget } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { parseSarifReport, SARIF_IMPORT_VERSION } from "@lyrashield/security"
import { logger } from "@lyrashield/logger"
import { authErrorResponse, withCookieMutation } from "../../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../../lib/api-response"
import { z } from "zod"
import { createHash } from "node:crypto"

const IdSchema = z.string().min(1).max(128)
const MAX_BYTES = 5 * 1024 * 1024
const severityOrder = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as const
const EVIDENCE_CONFLICT = "Conflicting immutable SARIF evidence"

function evidenceHash(payload: unknown): string {
  const canonical = JSON.stringify(payload, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0
          )
        )
      : value
  )
  return createHash("sha256").update(canonical).digest("hex")
}

/** Imported detections never create coverage or verification receipts. */
async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: scanId } = await params
  const workspace = IdSchema.safeParse(new URL(request.url).searchParams.get("workspaceId"))
  if (!workspace.success || !IdSchema.safeParse(scanId).success) {
    return apiError("BAD_REQUEST", "Valid scan and workspace IDs are required", 400)
  }
  const workspaceId = workspace.data
  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.scan.create)
    // Scan-create delegation does not authorize importing arbitrary findings.
    if (session.oauth)
      return apiError("FORBIDDEN", "SARIF import requires a browser session or write API key", 403)
    const scan = await prisma.scan.findFirst({
      where: { id: scanId, workspaceId, deletedAt: null },
      select: { id: true, targetId: true, createdAt: true },
    })
    if (!scan?.targetId) return apiError("NOT_FOUND", "Scan not found", 404)

    if (Number(request.headers.get("content-length")) > MAX_BYTES) {
      return apiError("BAD_REQUEST", "SARIF payload exceeds the 5 MiB limit", 413)
    }
    // Count streamed bytes before buffering; Content-Length is untrusted.
    const reader = request.body?.getReader()
    if (!reader) return apiError("BAD_REQUEST", "Request body is empty", 400)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BYTES) {
          await reader.cancel()
          return apiError("BAD_REQUEST", "SARIF payload exceeds the 5 MiB limit", 413)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const parsed = parseSarifReport(Buffer.concat(chunks).toString("utf8"), scan.targetId)
    if ("error" in parsed) return apiError("BAD_REQUEST", parsed.error, 400)
    const targetId = scan.targetId
    const counts = await withWorkspaceRLS(
      workspaceId,
      async (tx) => {
        // Serialize imports for this target. Findings and candidates commit together.
        await tx.$executeRaw`SELECT id FROM "Target" WHERE id = ${targetId} AND "workspaceId" = ${workspaceId} AND "deletedAt" IS NULL FOR UPDATE`
        const priorCandidates = await tx.findingCandidate.findMany({
          where: {
            workspaceId,
            scanId,
            scannerSource: "external_import",
            dedupeKey: { in: parsed.findings.map((record) => record.dedupeKey) },
          },
          select: { dedupeKey: true, evidenceHash: true },
        })
        const seen = new Set(priorCandidates.map((candidate) => candidate.dedupeKey))
        const hashes = new Map(
          priorCandidates.map((candidate) => [candidate.dedupeKey, candidate.evidenceHash])
        )
        // Reject conflicting replays and intra-report duplicates before any write.
        for (const record of parsed.findings) {
          const hash = evidenceHash(record.payload)
          const previous = hashes.get(record.dedupeKey)
          if (previous !== undefined && previous !== hash) {
            // Legacy hashes used JSON insertion order. PostgreSQL JSONB equality
            // accepts their semantic replay without loading large stored payloads.
            const legacyReplay = seen.has(record.dedupeKey)
              ? await tx.findingCandidate.findFirst({
                  where: {
                    workspaceId,
                    scanId,
                    scannerSource: "external_import",
                    dedupeKey: record.dedupeKey,
                    payload: { equals: record.payload as never },
                  },
                  select: { id: true },
                })
              : null
            if (!legacyReplay) throw new Error(EVIDENCE_CONFLICT)
          }
          hashes.set(record.dedupeKey, hash)
        }
        let imported = 0
        let corroborated = 0
        for (const record of parsed.findings) {
          const existing = await tx.finding.findFirst({
            where: { workspaceId, targetId, dedupeKey: record.dedupeKey },
            select: {
              id: true,
              scanId: true,
              status: true,
              severity: true,
              scan: { select: { createdAt: true } },
            },
          })
          // Replays and older assessments must not replace newer detection state.
          const refresh =
            existing &&
            !seen.has(record.dedupeKey) &&
            (existing.scanId === scanId || scan.createdAt > existing.scan.createdAt)
          const reopen =
            refresh && (existing.status === "FIXED" || existing.status === "FIXED_PENDING_RETEST")
          const finding = await tx.finding.upsert({
            where: { targetId_dedupeKey: { targetId, dedupeKey: record.dedupeKey } },
            create: {
              workspaceId,
              scanId,
              targetId,
              title: record.title,
              summary: record.summary,
              category: "external_import",
              cwe: record.cwe,
              owaspCategory: record.owaspCategory,
              sarifRuleId: record.sarifRuleId,
              severity: record.severity,
              confidence: "low",
              verified: false,
              verificationStatus: "DETECTED",
              verificationMethod: "SCANNER_DETECTION",
              verificationReason:
                "Third-party SARIF detection; no independent LyraShield verification.",
              dedupeKey: record.dedupeKey,
            },
            update: refresh
              ? {
                  scanId,
                  lastSeenAt: new Date(),
                  // External imports may strengthen a blocker, never lower it.
                  severity:
                    severityOrder[record.severity] > severityOrder[existing.severity]
                      ? record.severity
                      : existing.severity,
                  verified: false,
                  verificationStatus: "DETECTED",
                  verificationMethod: "SCANNER_DETECTION",
                  verificationReason:
                    "Third-party SARIF re-detection; independent verification is required for this assessment.",
                  ...(reopen ? { status: "OPEN", fixedAt: null } : {}),
                }
              : {},
            select: { id: true },
          })
          await tx.findingCandidate.upsert({
            where: {
              scanId_dedupeKey_scannerSource: {
                scanId,
                dedupeKey: record.dedupeKey,
                scannerSource: "external_import",
              },
            },
            create: {
              workspaceId,
              scanId,
              targetId,
              findingId: finding.id,
              scannerSource: "external_import",
              dedupeKey: record.dedupeKey,
              payload: record.payload as never,
              evidenceHash: hashes.get(record.dedupeKey)!,
            },
            // Preserve the original evidence on replay, including verified candidates.
            update: {},
          })
          seen.add(record.dedupeKey)
          if (existing) corroborated++
          else imported++
        }
        await tx.scanEvent.create({
          data: {
            scanId,
            stage: "scanner",
            level: "info",
            message: `Imported ${imported} SARIF finding(s)`,
            metadata: {
              sarifImport: SARIF_IMPORT_VERSION,
              imported,
              corroborated,
              rejected: parsed.rejected,
            },
          },
        })
        return { imported, corroborated }
      },
      { timeout: 60_000 }
    )
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "scan.sarif_import",
        resourceType: "scan",
        resourceId: scanId,
        metadata: { ...counts, rejected: parsed.rejected, importVersion: SARIF_IMPORT_VERSION },
      },
    })
    // Terminal scans already have cached verdicts; imported blockers must be visible.
    await evaluateGateForTarget(workspaceId, targetId)
    const response = apiSuccess({
      importVersion: SARIF_IMPORT_VERSION,
      toolName: parsed.toolName,
      toolVersion: parsed.toolVersion,
      ...counts,
      rejected: parsed.rejected,
      resultCount: parsed.resultCount,
    })
    response.headers.set("Cache-Control", "private, no-store")
    return response
  } catch (error) {
    if (error instanceof Error && error.message === EVIDENCE_CONFLICT) {
      return apiError(
        "CONFLICT",
        "This scan already has different SARIF evidence for this finding. Import new evidence into a new scan.",
        409
      )
    }
    const auth = authErrorResponse(error)
    if (auth) return auth
    logger.error("SARIF import failed", {
      scanId,
      workspaceId,
      error: error instanceof Error ? error.message : "Unknown error",
    })
    return apiError("INTERNAL_ERROR", "Unable to import SARIF report", 500)
  }
}

export const POST = withCookieMutation(post)
