import { prisma, withWorkspaceRLS, evaluateGateForTarget } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { parseSarifReport, SARIF_IMPORT_VERSION } from "@lyrashield/security"
import { logger } from "@lyrashield/logger"
import { authErrorResponse, withCookieMutation } from "../../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../../lib/api-response"
import { revalidateDashboardAggregates } from "../../../../../../lib/cache"
import { z } from "zod"
import { createHash } from "node:crypto"

const IdSchema = z.string().min(1).max(128)
const MAX_BYTES = 5 * 1024 * 1024
const severityOrder = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as const
const EVIDENCE_CONFLICT = "Conflicting immutable SARIF evidence"

function canonicalJson(payload: unknown): string {
  return (
    JSON.stringify(payload, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0
            )
          )
        : value
    ) ?? "null"
  )
}

function evidenceHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex")
}

function coalesceSeverityDuplicates<
  T extends {
    dedupeKey: string
    severity: keyof typeof severityOrder
    payload: Record<string, unknown>
  },
>(records: T[]): T[] {
  const result: T[] = []
  const firstByKey = new Map<string, { index: number; severityIndependentPayload: string }>()
  for (const record of records) {
    const sarifResult = record.payload.sarifResult
    const normalizedPayload =
      sarifResult && typeof sarifResult === "object" && !Array.isArray(sarifResult)
        ? canonicalJson({
            ...record.payload,
            sarifResult: Object.fromEntries(
              Object.entries(sarifResult).filter(([key]) => key !== "level")
            ),
          })
        : canonicalJson(record.payload)
    const previous = firstByKey.get(record.dedupeKey)
    if (previous && previous.severityIndependentPayload === normalizedPayload) {
      if (severityOrder[record.severity] > severityOrder[result[previous.index]!.severity]) {
        result[previous.index] = record
      }
      continue
    }
    if (!previous) {
      firstByKey.set(record.dedupeKey, {
        index: result.length,
        severityIndependentPayload: normalizedPayload,
      })
    }
    // Keep a conflicting duplicate so the immutable-evidence check rejects the
    // entire report before writing any finding or candidate rows.
    result.push(record)
  }
  return result
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
    const findings = coalesceSeverityDuplicates(parsed.findings)
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
            dedupeKey: { in: findings.map((record) => record.dedupeKey) },
          },
          select: { dedupeKey: true, evidenceHash: true },
        })
        const seen = new Set(priorCandidates.map((candidate) => candidate.dedupeKey))
        const hashes = new Map(
          priorCandidates.map((candidate) => [candidate.dedupeKey, candidate.evidenceHash])
        )
        const legacyConflicts: Array<(typeof parsed.findings)[number]> = []
        // Reject conflicting replays and intra-report duplicates before any write.
        for (const record of findings) {
          const hash = evidenceHash(record.payload)
          const previous = hashes.get(record.dedupeKey)
          if (previous !== undefined && previous !== hash) {
            if (!seen.has(record.dedupeKey)) throw new Error(EVIDENCE_CONFLICT)
            // Legacy hashes used JSON insertion order. Batch JSONB semantic checks
            // to keep legacy replays from restoring per-row reads.
            legacyConflicts.push(record)
          }
          hashes.set(record.dedupeKey, hash)
        }
        if (legacyConflicts.length) {
          const legacyCandidates = await tx.findingCandidate.findMany({
            where: {
              workspaceId,
              scanId,
              scannerSource: "external_import",
              OR: legacyConflicts.map((record) => ({
                dedupeKey: record.dedupeKey,
                payload: { equals: record.payload as never },
              })),
            },
            select: { dedupeKey: true, payload: true },
          })
          const semanticReplays = new Set(
            legacyCandidates.map((candidate) =>
              JSON.stringify([candidate.dedupeKey, canonicalJson(candidate.payload)])
            )
          )
          if (
            legacyConflicts.some(
              (record) =>
                !semanticReplays.has(
                  JSON.stringify([record.dedupeKey, canonicalJson(record.payload)])
                )
            )
          ) {
            throw new Error(EVIDENCE_CONFLICT)
          }
        }

        const dedupeKeys = [...new Set(findings.map((record) => record.dedupeKey))]
        const existingFindings = dedupeKeys.length
          ? await tx.finding.findMany({
              where: { workspaceId, targetId, dedupeKey: { in: dedupeKeys } },
              select: {
                id: true,
                dedupeKey: true,
                scanId: true,
                status: true,
                severity: true,
                scan: { select: { createdAt: true } },
              },
            })
          : []
        const findingsByKey = new Map(
          existingFindings.map((finding) => [finding.dedupeKey, finding])
        )
        const findingCreateRows: Array<{
          workspaceId: string
          scanId: string
          targetId: string
          title: string
          summary: string
          category: string
          cwe: string | null
          owaspCategory: string | null
          sarifRuleId: string | null
          severity: (typeof parsed.findings)[number]["severity"]
          confidence: "low"
          verified: false
          verificationStatus: "DETECTED"
          verificationMethod: "SCANNER_DETECTION"
          verificationReason: string
          dedupeKey: string
        }> = []
        const createKeys = new Set<string>()
        const refreshRows = new Map<
          string,
          {
            id: string
            severity: (typeof parsed.findings)[number]["severity"]
            reopen: boolean
            lastSeenAt: Date
          }
        >()
        const candidateRecords = new Map<string, (typeof parsed.findings)[number]>()
        let imported = 0
        let corroborated = 0
        for (const record of findings) {
          const existing = findingsByKey.get(record.dedupeKey)
          // Replays and older assessments must not replace newer detection state.
          const refresh =
            existing &&
            !seen.has(record.dedupeKey) &&
            (existing.scanId === scanId || scan.createdAt > existing.scan.createdAt)
          const reopen =
            refresh && (existing.status === "FIXED" || existing.status === "FIXED_PENDING_RETEST")
          if (!existing) {
            if (!createKeys.has(record.dedupeKey)) {
              createKeys.add(record.dedupeKey)
              findingCreateRows.push({
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
              })
            }
            imported++
          } else {
            corroborated++
            if (refresh) {
              const severity =
                severityOrder[record.severity] > severityOrder[existing.severity]
                  ? record.severity
                  : existing.severity
              refreshRows.set(existing.id, {
                id: existing.id,
                severity,
                reopen: Boolean(reopen),
                lastSeenAt: new Date(),
              })
              findingsByKey.set(record.dedupeKey, {
                ...existing,
                scanId,
                status: reopen ? "OPEN" : existing.status,
                severity,
                scan: { createdAt: scan.createdAt },
              })
            }
          }
          if (!seen.has(record.dedupeKey)) candidateRecords.set(record.dedupeKey, record)
          seen.add(record.dedupeKey)
        }

        const createdFindings = findingCreateRows.length
          ? await tx.finding.createManyAndReturn({
              data: findingCreateRows,
              skipDuplicates: true,
              select: { id: true, dedupeKey: true },
            })
          : []
        const findingIdsByKey = new Map(
          existingFindings.map((finding) => [finding.dedupeKey, finding.id])
        )
        for (const finding of createdFindings) findingIdsByKey.set(finding.dedupeKey, finding.id)

        const refreshEntries = [...refreshRows.values()]
        if (refreshEntries.length) {
          await tx.$executeRaw`
            UPDATE "Finding" AS f
            SET "scanId" = v."scanId",
                "lastSeenAt" = v."lastSeenAt",
                "severity" = v."severity"::"FindingSeverity",
                "verified" = false,
                "verificationStatus" = 'DETECTED'::"FindingVerificationStatus",
                "verificationMethod" = 'SCANNER_DETECTION'::"FindingVerificationMethod",
                "verificationReason" = 'Third-party SARIF re-detection; independent verification is required for this assessment.',
                "status" = CASE WHEN v."reopen" THEN 'OPEN'::"FindingStatus" ELSE f."status" END,
                "fixedAt" = CASE WHEN v."reopen" THEN NULL ELSE f."fixedAt" END,
                "updatedAt" = now()
            FROM unnest(
              ${refreshEntries.map((row) => row.id)}::text[],
              ${refreshEntries.map(() => scanId)}::text[],
              ${refreshEntries.map((row) => row.lastSeenAt)}::timestamptz[],
              ${refreshEntries.map((row) => row.severity)}::text[],
              ${refreshEntries.map((row) => row.reopen)}::boolean[]
            ) AS v("id", "scanId", "lastSeenAt", "severity", "reopen")
            WHERE f."id" = v."id"
              AND f."workspaceId" = ${workspaceId}
              AND f."targetId" = ${targetId}
          `
        }

        const missingIds = [...candidateRecords.keys()].filter((key) => !findingIdsByKey.has(key))
        if (missingIds.length) {
          const racedFindings = await tx.finding.findMany({
            where: { workspaceId, targetId, dedupeKey: { in: missingIds } },
            select: { id: true, dedupeKey: true },
          })
          for (const finding of racedFindings) findingIdsByKey.set(finding.dedupeKey, finding.id)
        }
        const candidateRows = [...candidateRecords.values()].map((record) => {
          const findingId = findingIdsByKey.get(record.dedupeKey)
          if (!findingId) throw new Error("SARIF finding disappeared during import")
          return {
            workspaceId,
            scanId,
            targetId,
            findingId,
            scannerSource: "external_import",
            dedupeKey: record.dedupeKey,
            payload: record.payload as never,
            evidenceHash: hashes.get(record.dedupeKey)!,
          }
        })
        if (candidateRows.length) {
          await tx.findingCandidate.createMany({ data: candidateRows, skipDuplicates: true })
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
    revalidateDashboardAggregates(workspaceId)
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
