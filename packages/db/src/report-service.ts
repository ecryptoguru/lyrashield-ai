import { prisma } from "./client"
import { createHash, randomBytes } from "crypto"
import { logger } from "@lyrashield/logger"
import type { Report } from "./generated/prisma"

export interface CreateReportParams {
  workspaceId: string
  scanId?: string
  type?: string
  title: string
  createdById: string
}

export interface ShareableReport {
  id: string
  title: string
  type: string
  status: string
  format: string
  shareUrl: string | null
  shareExpiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  scanSummary?: {
    scanId: string
    status: string
    summary: string | null
    targetName: string
    findingsCount: number
    findingsBySeverity: Record<string, number>
  } | null
}

export async function createReport(params: CreateReportParams): Promise<Report> {
  const report = await prisma.report.create({
    data: {
      workspaceId: params.workspaceId,
      ...(params.scanId ? { scanId: params.scanId } : {}),
      type: params.type ?? "developer",
      title: params.title,
      status: "generated",
      format: "html",
      createdById: params.createdById,
    },
  })

  logger.info("Report created", { reportId: report.id, workspaceId: params.workspaceId })
  return report
}

export async function generateShareToken(
  reportId: string
): Promise<{ token: string; tokenHash: string }> {
  const token = randomBytes(32).toString("hex")
  const tokenHash = createHash("sha256").update(token).digest("hex")

  await prisma.report.update({
    where: { id: reportId },
    data: {
      shareTokenHash: tokenHash,
      shareExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      revokedAt: null,
    },
  })

  return { token, tokenHash }
}

export async function revokeShareToken(reportId: string): Promise<void> {
  await prisma.report.update({
    where: { id: reportId },
    data: {
      revokedAt: new Date(),
    },
  })
}

export async function getReportByShareToken(token: string): Promise<Report | null> {
  const tokenHash = createHash("sha256").update(token).digest("hex")

  const report = await prisma.report.findFirst({
    where: { shareTokenHash: tokenHash, revokedAt: null, deletedAt: null },
  })

  if (!report) return null

  if (report.shareExpiresAt && report.shareExpiresAt < new Date()) {
    logger.warn("Share token expired", { reportId: report.id })
    return null
  }

  return report
}

export async function getShareableReport(
  reportId: string,
  workspaceId: string
): Promise<ShareableReport | null> {
  const report = await prisma.report.findFirst({
    where: { id: reportId, workspaceId, deletedAt: null },
  })

  if (!report) return null

  let scanSummary: ShareableReport["scanSummary"] = null

  if (report.scanId) {
    // Scope the scan lookup to the report's workspace. This is the public share
    // path (no request-scoped workspace context is set), so we must NOT rely on
    // the Prisma extension's implicit read-scoping — filter explicitly. (S4)
    const scan = await prisma.scan.findFirst({
      where: { id: report.scanId, workspaceId, deletedAt: null },
      include: {
        target: { select: { name: true } },
        _count: { select: { findings: { where: { deletedAt: null } } } },
      },
    })

    if (scan) {
      const findings = await prisma.finding.findMany({
        where: { scanId: scan.id, workspaceId, deletedAt: null },
        select: { severity: true },
      })

      const bySeverity: Record<string, number> = {}
      for (const f of findings) {
        bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
      }

      scanSummary = {
        scanId: scan.id,
        status: scan.status,
        summary: scan.summary,
        targetName: scan.target?.name ?? "Unknown",
        findingsCount: findings.length,
        findingsBySeverity: bySeverity,
      }
    }
  }

  return {
    id: report.id,
    title: report.title,
    type: report.type,
    status: report.status,
    format: report.format,
    shareUrl: report.shareTokenHash ? `/reports/shared/${report.id}` : null,
    shareExpiresAt: report.shareExpiresAt,
    revokedAt: report.revokedAt,
    createdAt: report.createdAt,
    scanSummary,
  }
}

export async function listReports(
  workspaceId: string,
  cursor?: string,
  limit?: number
): Promise<{
  items: Report[]
  nextCursor: string | null
}> {
  const lim = Math.min(Math.max(limit ?? 50, 1), 100)

  const reports = await prisma.report.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: lim + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })

  const hasMore = reports.length > lim
  const items = hasMore ? reports.slice(0, lim) : reports
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

  return { items, nextCursor }
}
