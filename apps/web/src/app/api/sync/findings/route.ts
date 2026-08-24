import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { withWorkspaceRLS } from "@lyrashield/db"
import { env } from "@lyrashield/config"
import { requireAuth } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { hasSyncWriteAccess } from "../../../../lib/sync-auth"
import { markLegacySyncResponse, resolveSyncCredential } from "../../../../lib/sync-license-auth"

export const dynamic = "force-dynamic"

// Detection-state-only: only OPEN is accepted from desktop; FIXED is mapped to FIXED_PENDING_RETEST
// Verified is always false (server-enforced). Reject forged terminal or verified=true.
const ALLOWED_SYNC_STATUSES = new Set(["OPEN", "FIXED_PENDING_RETEST"])
const STATUS_FIX_MAPPING: Record<string, string> = {
  FIXED: "FIXED_PENDING_RETEST",
}

const FindingSyncSchema = z.object({
  workspaceId: z.string().min(1),
  syncSessionToken: z.string().min(1).max(4096).optional(),
  // One-release compatibility fallback. New clients send only syncSessionToken.
  licenseKey: z.string().min(1).max(200).optional(),
  // Monotonic CAS: client sends seq it believes is current. Server atomically increments.
  // Accept either `expectedSeq` or legacy `expectedPreviousCursor` (numeric string) for compat.
  expectedSeq: z.number().int().min(0).optional(),
  expectedPreviousCursor: z.union([z.number().int().min(0), z.string()]).optional(),
  findings: z
    .array(
      z.object({
        id: z.string().min(1),
        severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]),
        title: z.string().min(1).max(500),
        description: z.string().max(5000).optional(),
        status: z.string().default("OPEN"),
        verified: z.boolean().default(false),
        filePath: z.string().max(1000).optional(),
        lineNumber: z.number().int().positive().optional(),
        detectedAt: z.string().datetime(),
      })
    )
    .max(env.LYRASHIELD_SYNC_MAX_FINDINGS_PER_BATCH, "Too many findings in one batch"),
  reports: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(200),
        format: z.string().default("json"),
        content: z.string().max(500_000),
        createdAt: z.string().datetime(),
      })
    )
    .max(50)
    .default([]),
})

/**
 * POST /api/sync/findings
 *
 * Authenticated monotonic evidence sync. All writes bound to workspace via withWorkspaceRLS.
 * CAS on SyncCursor.seq prevents replay/rewind. Detection-state-only: verified forced false,
 * FIXED mapped to FIXED_PENDING_RETEST and rejected if forged terminal persists, unknown statuses rejected.
 * Reports persisted atomically in same tx (full persistence; never count discarded input).
 */
export async function POST(request: Request) {
  try {
    const session = await requireAuth()
    const body: unknown = await request.json().catch(() => null)
    const parsed = FindingSyncSchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const raw = parsed.data
    // Normalize expected seq: prefer expectedSeq, fallback to expectedPreviousCursor
    let expectedSeq: number | undefined = raw.expectedSeq
    if (expectedSeq === undefined && raw.expectedPreviousCursor !== undefined) {
      const v = raw.expectedPreviousCursor
      if (typeof v === "number") expectedSeq = v
      else {
        const n = Number(v)
        if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) expectedSeq = n
      }
    }
    const { workspaceId, syncSessionToken, licenseKey, findings, reports } = raw

    if (!hasSyncWriteAccess(session, workspaceId)) {
      return apiError("FORBIDDEN", "A write-capable key for this workspace is required", 403)
    }

    // Detection-state-only validation BEFORE any DB write
    for (const f of findings) {
      if (f.verified === true) {
        return apiError(
          "FORGED_VERIFICATION",
          "verified must be false for local evidence sync",
          400
        )
      }
      // Map FIXED -> FIXED_PENDING_RETEST, reject other terminal/unknown
      const mapped = STATUS_FIX_MAPPING[f.status] ?? f.status
      if (mapped === "FIXED") {
        // Direct FIXED not allowed (should have been mapped)
        return apiError(
          "FORGED_TERMINAL_STATUS",
          "FIXED status not allowed via sync; use FIXED_PENDING_RETEST",
          400
        )
      }
      if (!ALLOWED_SYNC_STATUSES.has(mapped)) {
        return apiError("INVALID_STATUS", `status '${f.status}' not allowed via sync`, 400)
      }
    }

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.userId } },
    })
    if (!membership || membership.status !== "active") {
      return apiError("FORBIDDEN", "You do not have access to this workspace", 403)
    }

    const credential = await resolveSyncCredential({
      workspaceId,
      session,
      syncSessionToken,
      licenseKey,
    })
    if (!credential.ok) {
      return apiError(credential.code, credential.message, credential.status)
    }
    const { license, legacyLicenseKey } = credential

    // Need cursor existence check — must be bound to workspace via RLS
    // Fetch cursor inside withWorkspaceRLS to respect NOBYPASSRLS, but we need seq for CAS, so do a preliminary fetch via withWorkspaceRLS read
    const cursorPre = await withWorkspaceRLS(workspaceId, async (tx) =>
      tx.syncCursor.findUnique({
        where: { workspaceId_licenseId: { workspaceId, licenseId: license.id } },
      })
    )
    if (!cursorPre) {
      return apiError(
        "SYNC_NOT_CONNECTED",
        "Sync has not been established for this workspace. Call /api/sync/connect first.",
        409
      )
    }

    const currentSeq = Number(cursorPre.seq)
    // Require expectedSeq when cursor already advanced, otherwise treat missing as 0 for first batch compat
    if (expectedSeq === undefined) {
      // For new cursors at seq 0, allow missing expectedSeq as 0
      if (currentSeq !== 0) {
        return apiError(
          "CURSOR_STALE",
          "expectedSeq is required for monotonic sync",
          409,
          undefined,
          {
            currentSeq,
          }
        )
      }
      expectedSeq = 0
    }

    // Exact replay detection: if expectedSeq < currentSeq, check if this batch is identical to already-persisted state
    // We compare externalIds set against existing findings for this scan
    if (expectedSeq !== currentSeq) {
      if (findings.length === 0 && reports.length === 0) {
        // Empty batch with stale seq — treat as rewind attempt
        return apiError("CURSOR_REWIND", "Cursor cannot move backwards", 409, undefined, {
          currentSeq,
          expectedSeq,
        })
      }
      // Check exact replay: all externalIds already exist and seq is exactly one ahead (common replay after success)
      const externalIds = findings.map((f) => `local:${license.id}:${f.id}`)
      const existingCount = await withWorkspaceRLS(workspaceId, async (tx) =>
        tx.finding.count({ where: { id: { in: externalIds } } })
      )
      const isExactReplay = existingCount === findings.length && findings.length > 0
      // For exact replay, return idempotent success without advancing
      if (isExactReplay && expectedSeq === currentSeq - 1) {
        return markLegacySyncResponse(
          apiSuccess(
            {
              synced: true,
              duplicate: true,
              findingsPersisted: 0,
              reportsPersisted: 0,
              reportsReceived: reports.length,
              seq: currentSeq,
              lastSyncedAt: cursorPre.lastSyncedAt.toISOString(),
              lastSyncedFindingId: cursorPre.lastSyncedFindingId ?? null,
            },
            200
          ),
          legacyLicenseKey
        )
      }
      // Check if same seq but different content already applied (duplicate idempotency at same seq)
      if (isExactReplay && expectedSeq === currentSeq) {
        return markLegacySyncResponse(
          apiSuccess(
            {
              synced: true,
              duplicate: true,
              findingsPersisted: 0,
              reportsPersisted: 0,
              reportsReceived: reports.length,
              seq: currentSeq,
              lastSyncedAt: cursorPre.lastSyncedAt.toISOString(),
              lastSyncedFindingId: cursorPre.lastSyncedFindingId ?? null,
            },
            200
          ),
          legacyLicenseKey
        )
      }
      return apiError(
        "CURSOR_STALE",
        "Stale cursor — batch was reordered or replayed with different content",
        409,
        undefined,
        {
          currentSeq,
          expectedSeq,
        }
      )
    }

    // Inside withWorkspaceRLS atomic transaction: create/find scan, upsert findings (verified forced false), persist reports, CAS seq increment
    const result = await withWorkspaceRLS(workspaceId, async (tx) => {
      // CAS enforcement: re-check seq inside tx before write (defends concurrent batches)
      const fresh = await tx.syncCursor.findUnique({
        where: { workspaceId_licenseId: { workspaceId, licenseId: license.id } },
      })
      if (!fresh)
        throw Object.assign(new Error("SYNC_NOT_CONNECTED"), { code: "SYNC_NOT_CONNECTED" })
      if (Number(fresh.seq) !== expectedSeq) {
        throw Object.assign(new Error("CURSOR_STALE"), {
          code: "CURSOR_STALE",
          currentSeq: Number(fresh.seq),
          expectedSeq,
        })
      }

      // Find or create synthetic LOCAL_SYNC scan
      let syncScan = await tx.scan.findFirst({ where: { workspaceId, triggerType: "local_sync" } })
      if (!syncScan) {
        try {
          syncScan = await tx.scan.create({
            data: {
              workspaceId,
              goal: "LAUNCH_REVIEW",
              mode: "SAFE",
              status: "COMPLETED",
              triggerType: "local_sync",
              summary: "Findings synced from LyraShield Local desktop client",
              createdById: session.userId,
              startedAt: new Date(),
              endedAt: new Date(),
            },
          })
        } catch {
          syncScan = await tx.scan.findFirst({ where: { workspaceId, triggerType: "local_sync" } })
          if (!syncScan) throw new Error("Failed to create sync scan")
        }
      }

      let persistedFindings = 0
      const lastFindingId =
        findings.length > 0 ? findings[findings.length - 1]!.id : fresh.lastSyncedFindingId

      for (const finding of findings) {
        const externalId = `local:${license.id}:${finding.id}`
        const mappedStatus = STATUS_FIX_MAPPING[finding.status] ?? finding.status
        const finalStatus = ALLOWED_SYNC_STATUSES.has(mappedStatus) ? mappedStatus : "OPEN"
        const technicalDetail = [
          finding.filePath ? `File: ${finding.filePath}` : null,
          finding.lineNumber ? `Line: ${finding.lineNumber}` : null,
          finding.description ?? null,
        ]
          .filter(Boolean)
          .join("\n")

        await tx.finding.upsert({
          where: { id: externalId },
          create: {
            id: externalId,
            workspaceId,
            scanId: syncScan.id,
            title: finding.title,
            summary: finding.description ?? finding.title,
            severity: finding.severity,
            status: finalStatus as never,
            verified: false,
            technicalDetail: technicalDetail || null,
            dedupeKey: finding.id,
            firstSeenAt: new Date(finding.detectedAt),
            lastSeenAt: new Date(),
          },
          update: {
            title: finding.title,
            summary: finding.description ?? finding.title,
            severity: finding.severity,
            status: finalStatus as never,
            verified: false,
            technicalDetail: technicalDetail || null,
            lastSeenAt: new Date(),
          },
        })
        persistedFindings++
      }

      // Reports: full atomic persistence inside same tx, bounded (already validated max 50, 500k each)
      // Never count discarded input — we validated and persist all received reports, so count persisted == received
      let reportsPersisted = 0
      for (const report of reports) {
        // Persist as Report linked to syncScan, with contentJson holding the evidence payload
        await tx.report.create({
          data: {
            workspaceId,
            scanId: syncScan.id,
            type: "developer",
            title: report.name,
            status: "generated",
            format: report.format ?? "json",
            contentJson: {
              source: "local_sync",
              reportId: report.id,
              content: report.content,
              createdAt: report.createdAt,
              licenseId: license.id,
            },
            createdById: session.userId,
          },
        })
        reportsPersisted++
      }

      // CAS seq increment — use updateMany with seq condition for atomicity
      const nextSeq = Number(fresh.seq) + 1
      // Only advance seq if we actually persisted something or batch was non-empty
      // Empty batches still advance to keep monotonicity? For sync we advance only on non-empty to avoid noop increments
      const seqToSet = findings.length > 0 || reports.length > 0 ? nextSeq : Number(fresh.seq)
      const updateRes = await tx.syncCursor.updateMany({
        where: { id: fresh.id, seq: fresh.seq },
        data: {
          seq: BigInt(seqToSet),
          lastSyncedAt: new Date(),
          lastSyncedFindingId: lastFindingId,
        },
      })
      if (updateRes.count === 0) {
        throw Object.assign(new Error("CURSOR_CONCURRENT"), { code: "CURSOR_CONCURRENT" })
      }
      const updated = await tx.syncCursor.findUnique({ where: { id: fresh.id } })
      if (!updated) throw new Error("Cursor missing after update")
      return {
        persistedFindings,
        reportsPersisted,
        reportsReceived: reports.length,
        seq: Number(updated.seq),
        lastSyncedAt: updated.lastSyncedAt,
        lastSyncedFindingId: updated.lastSyncedFindingId,
        lastFindingId,
      }
    })

    logger.info("Sync findings persisted", {
      licenseId: license.id,
      workspaceId,
      findingsCount: result.persistedFindings,
      reportsCount: result.reportsPersisted,
      seq: result.seq,
    })

    return markLegacySyncResponse(
      apiSuccess(
        {
          synced: true,
          findingsPersisted: result.persistedFindings,
          reportsPersisted: result.reportsPersisted,
          reportsReceived: result.reportsReceived,
          seq: result.seq,
          lastSyncedAt: result.lastSyncedAt.toISOString(),
          lastSyncedFindingId: result.lastSyncedFindingId ?? null,
          // Provide legacy cursor alias for desktop compat
          cursor: String(result.seq),
        },
        200
      ),
      legacyLicenseKey
    )
  } catch (error: unknown) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    const maybeCode = (error as { code?: string })?.code
    if (maybeCode === "CURSOR_STALE" || maybeCode === "CURSOR_CONCURRENT") {
      const cur = (error as { currentSeq?: number }).currentSeq
      const exp = (error as { expectedSeq?: number }).expectedSeq
      return apiError(
        "CURSOR_STALE",
        "Stale or concurrent cursor — fetch latest seq and retry",
        409,
        undefined,
        {
          currentSeq: cur,
          expectedSeq: exp,
        }
      )
    }
    if (maybeCode === "SYNC_NOT_CONNECTED") {
      return apiError("SYNC_NOT_CONNECTED", "Sync has not been established", 409)
    }
    logger.error("Sync findings failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to sync findings", 500)
  }
}
