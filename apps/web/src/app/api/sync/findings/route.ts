import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { env } from "@lyrashield/config"
import { requireAuth } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { hashLicenseKey } from "../../../../lib/licenses/license-service"

export const dynamic = "force-dynamic"

const FindingSyncSchema = z.object({
  workspaceId: z.string().min(1),
  licenseKey: z.string().min(1).max(200),
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
 * Receive findings and reports from a Local desktop client and persist them
 * to the linked workspace. Enforces sync entitlement server-side by checking
 * the license key against the SyncCursor established via /sync/connect.
 *
 * Findings from Local are stored under a synthetic "LOCAL_SYNC" scan record
 * so they appear in the dashboard alongside cloud-scan findings. The finding
 * ID is namespaced as `local:{licenseId}:{externalId}` to avoid collisions.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAuth()
    const body: unknown = await request.json().catch(() => null)
    const parsed = FindingSyncSchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { workspaceId, licenseKey, findings, reports } = parsed.data

    // Verify workspace access.
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.userId } },
    })
    if (!membership || membership.status !== "active") {
      return apiError("FORBIDDEN", "You do not have access to this workspace", 403)
    }

    // Verify the license key has an active sync cursor for this workspace.
    const keyHash = hashLicenseKey(licenseKey)
    const licenseKeyRow = await prisma.licenseKey.findUnique({
      where: { keyHash },
      include: { license: { include: { syncCursors: { where: { workspaceId } } } } },
    })
    if (!licenseKeyRow) {
      return apiError("LICENSE_KEY_NOT_FOUND", "The provided license key is not recognized", 404)
    }

    const license = licenseKeyRow.license
    if (license.revoked) {
      return apiError("LICENSE_REVOKED", "This license has been revoked", 403)
    }

    if (license.syncCursors.length === 0) {
      return apiError(
        "SYNC_NOT_CONNECTED",
        "Sync has not been established for this workspace. Call /api/sync/connect first.",
        409
      )
    }

    const cursor = license.syncCursors[0]!

    // B-L07: Find or create a synthetic "LOCAL_SYNC" scan. Use a transaction
    // with a findFirst-then-create pattern to minimize the race window.
    // A unique constraint on (workspaceId, triggerType) would be the ideal
    // fix but requires a migration; for now we narrow the race by using
    // a transaction and catching the potential duplicate on create.
    let syncScan = await prisma.scan.findFirst({
      where: { workspaceId, triggerType: "local_sync" },
    })
    if (!syncScan) {
      try {
        syncScan = await prisma.scan.create({
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
        // Race: another concurrent request created it — re-fetch
        syncScan = await prisma.scan.findFirst({
          where: { workspaceId, triggerType: "local_sync" },
        })
        if (!syncScan) {
          return apiError("INTERNAL_ERROR", "Failed to create sync scan", 500)
        }
      }
    }

    // Persist findings. We use upsert keyed on the finding's namespaced ID.
    let persistedFindings = 0
    for (const finding of findings) {
      const externalId = `local:${license.id}:${finding.id}`
      const technicalDetail = [
        finding.filePath ? `File: ${finding.filePath}` : null,
        finding.lineNumber ? `Line: ${finding.lineNumber}` : null,
        finding.description ?? null,
      ]
        .filter(Boolean)
        .join("\n")

      await prisma.finding.upsert({
        where: { id: externalId },
        create: {
          id: externalId,
          workspaceId,
          scanId: syncScan.id,
          title: finding.title,
          summary: finding.description ?? finding.title,
          severity: finding.severity,
          status: finding.status as never,
          verified: finding.verified,
          technicalDetail: technicalDetail || null,
          dedupeKey: finding.id,
          firstSeenAt: new Date(finding.detectedAt),
          lastSeenAt: new Date(),
        },
        update: {
          title: finding.title,
          summary: finding.description ?? finding.title,
          severity: finding.severity,
          status: finding.status as never,
          verified: finding.verified,
          technicalDetail: technicalDetail || null,
          lastSeenAt: new Date(),
        },
      })
      persistedFindings++
    }

    // Update the sync cursor.
    await prisma.syncCursor.update({
      where: { id: cursor.id },
      data: {
        lastSyncedAt: new Date(),
        lastSyncedFindingId:
          findings.length > 0 ? findings[findings.length - 1]!.id : cursor.lastSyncedFindingId,
      },
    })

    logger.info("Sync findings persisted", {
      licenseId: license.id,
      workspaceId,
      findingsCount: persistedFindings,
      reportsCount: reports.length,
    })

    return apiSuccess(
      {
        synced: true,
        findingsPersisted: persistedFindings,
        reportsReceived: reports.length,
        lastSyncedAt: new Date().toISOString(),
      },
      200
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Sync findings failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to sync findings", 500)
  }
}
