import { prisma } from "./client"
import { createHash, randomBytes } from "crypto"
import { logger } from "@lyrashield/logger"
import type { Report } from "./generated/prisma"
import { gatherReportData } from "./report-generator"
import { getSystemPrisma } from "./system-client"

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
  assurance?: {
    verdict: string
    score: number | null
    grade: string | null
    narrative: string
    verifiedCount: number
    fixedCount: number
    retestSummary: { passed: number; failed: number; pending: number }
    findingsByStatus: Record<string, number>
    findingsByCategory: Record<string, number>
    ageBuckets: Record<string, number>
    scoreTrend: Array<{ score: number; grade: string; computedAt: string }>
    priorityActions: Array<{ label: string; detail: string; severity: string }>
    methodology: string[]
  } | null
}

function asNumberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number")
  )
}

function getSnapshotAssurance(contentJson: unknown): ShareableReport["assurance"] {
  if (!contentJson || typeof contentJson !== "object" || Array.isArray(contentJson)) return null
  const snapshot = contentJson as Record<string, unknown>
  const assurance = snapshot.assurance
  if (!assurance || typeof assurance !== "object" || Array.isArray(assurance)) return null
  const value = assurance as Record<string, unknown>
  if (typeof value.verdict !== "string" || typeof value.narrative !== "string") return null

  const retest =
    snapshot.retestSummary && typeof snapshot.retestSummary === "object"
      ? (snapshot.retestSummary as Record<string, unknown>)
      : {}
  const scoreTrend = Array.isArray(value.scoreTrend)
    ? value.scoreTrend.flatMap((point) => {
        if (!point || typeof point !== "object" || Array.isArray(point)) return []
        const item = point as Record<string, unknown>
        if (
          typeof item.score !== "number" ||
          typeof item.grade !== "string" ||
          !(typeof item.computedAt === "string" || item.computedAt instanceof Date)
        )
          return []
        return [
          {
            score: item.score,
            grade: item.grade,
            computedAt: new Date(item.computedAt).toISOString(),
          },
        ]
      })
    : []
  const priorityActions = Array.isArray(value.priorityActions)
    ? value.priorityActions.flatMap((action) => {
        if (!action || typeof action !== "object" || Array.isArray(action)) return []
        const item = action as Record<string, unknown>
        if (
          typeof item.label !== "string" ||
          typeof item.detail !== "string" ||
          typeof item.severity !== "string"
        )
          return []
        return [{ label: item.label, detail: item.detail, severity: item.severity }]
      })
    : []

  return {
    verdict: value.verdict,
    score: typeof value.score === "number" ? value.score : null,
    grade: typeof value.grade === "string" ? value.grade : null,
    narrative: value.narrative,
    verifiedCount: typeof snapshot.verifiedCount === "number" ? snapshot.verifiedCount : 0,
    fixedCount: typeof snapshot.fixedCount === "number" ? snapshot.fixedCount : 0,
    retestSummary: {
      passed: typeof retest.passed === "number" ? retest.passed : 0,
      failed: typeof retest.failed === "number" ? retest.failed : 0,
      pending: typeof retest.pending === "number" ? retest.pending : 0,
    },
    findingsByStatus: asNumberMap(snapshot.findingsByStatus),
    findingsByCategory: asNumberMap(snapshot.findingsByCategory),
    ageBuckets: asNumberMap(value.ageBuckets),
    scoreTrend,
    priorityActions,
    methodology: Array.isArray(value.methodology)
      ? value.methodology.filter((item): item is string => typeof item === "string")
      : [],
  }
}

function getSnapshotScanSummary(contentJson: unknown): ShareableReport["scanSummary"] | undefined {
  if (!contentJson || typeof contentJson !== "object" || Array.isArray(contentJson))
    return undefined

  const snapshot = contentJson as Record<string, unknown>
  const scanInfo = snapshot.scanInfo
  const findingsBySeverity = snapshot.findingsBySeverity

  if (!scanInfo || typeof scanInfo !== "object" || Array.isArray(scanInfo)) return undefined
  if (
    !findingsBySeverity ||
    typeof findingsBySeverity !== "object" ||
    Array.isArray(findingsBySeverity)
  )
    return undefined

  const scan = scanInfo as Record<string, unknown>
  if (
    typeof scan.scanId !== "string" ||
    typeof scan.status !== "string" ||
    typeof scan.targetName !== "string" ||
    typeof snapshot.totalFindings !== "number"
  )
    return undefined

  return {
    scanId: scan.scanId,
    status: scan.status,
    summary: typeof scan.summary === "string" ? scan.summary : null,
    targetName: "Private target",
    findingsCount: snapshot.totalFindings,
    findingsBySeverity: findingsBySeverity as Record<string, number>,
  }
}

export async function createReport(params: CreateReportParams): Promise<Report> {
  const type =
    params.type === "executive" || params.type === "compliance" ? params.type : "developer"
  const contentJson = await gatherReportData(params.workspaceId, params.scanId, type)
  const report = await prisma.report.create({
    data: {
      workspaceId: params.workspaceId,
      ...(params.scanId ? { scanId: params.scanId } : {}),
      type: params.type ?? "developer",
      title: params.title,
      status: "generated",
      format: "html",
      createdById: params.createdById,
      contentJson,
    },
  })

  logger.info("Report created", { reportId: report.id, workspaceId: params.workspaceId })
  return report
}

export async function generateShareToken(
  reportId: string
): Promise<{ token: string; tokenHash: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex")
  const tokenHash = createHash("sha256").update(token).digest("hex")
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  await prisma.report.update({
    where: { id: reportId },
    data: {
      shareTokenHash: tokenHash,
      shareExpiresAt: expiresAt,
      revokedAt: null,
    },
  })

  return { token, tokenHash, expiresAt }
}

export async function revokeShareToken(reportId: string): Promise<Date> {
  const revokedAt = new Date()
  await prisma.report.update({
    where: { id: reportId },
    data: {
      revokedAt,
    },
  })
  return revokedAt
}

export async function getReportByShareToken(token: string): Promise<Report | null> {
  const tokenHash = createHash("sha256").update(token).digest("hex")

  const report = await getSystemPrisma().report.findFirst({
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

  let scanSummary: ShareableReport["scanSummary"] =
    getSnapshotScanSummary(report.contentJson) ?? null

  if (report.scanId && !scanSummary) {
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
        targetName: "Private target",
        findingsCount: findings.length,
        findingsBySeverity: bySeverity,
      }
    }
  }

  return {
    id: report.id,
    title: "LyraShield Security Assurance Report",
    type: report.type,
    status: report.status,
    format: report.format,
    shareUrl: report.shareTokenHash ? `/reports/shared/${report.id}` : null,
    shareExpiresAt: report.shareExpiresAt,
    revokedAt: report.revokedAt,
    createdAt: report.createdAt,
    scanSummary,
    assurance: getSnapshotAssurance(report.contentJson),
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
