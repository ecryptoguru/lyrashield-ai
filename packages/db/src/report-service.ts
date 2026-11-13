import { prisma } from "./client"
import { createHash } from "crypto"

const SHARE_TOKEN_PATTERN = /^[a-f0-9]{64}$/i
import { logger } from "@lyrashield/logger"
import type { Report } from "./generated/prisma"
import { gatherReportData, parseWebMcpAssurance } from "./report-generator"
import { getSystemPrisma } from "./system-client"
import { withWorkspaceRLS, type ScopedTransaction } from "./rls"
import { parseLaunchReportProvenance } from "./launch-report-provenance"
import { isLaunchReportShareablePayload } from "./launch-report-html"
import { lockActiveTargetForDerivedWrite } from "./target-write-lock"

export {
  generateShareToken,
  generateReleasePacketShareToken,
  revokeShareToken,
  revokeReleasePacketShareToken,
} from "./report-share-tokens"

export interface CreateReportParams {
  workspaceId: string
  scanId?: string
  targetId?: string
  requireActiveTarget?: boolean
  type?: string
  title: string
  createdById: string
  /** Caller already holds `withDelegatedReadAuthority` for this target. */
  client?: ScopedTransaction
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
  webMcpAssurance?: {
    version: string
    detectorVersion: string
    coverageState: "COMPLETE" | "INCONCLUSIVE"
    eligibleFiles: number
    scannedFiles: number
    scannedBytes: number
    inventoryChecksum: string
    toolDefinitionsFound: number
    toolDefinitionsAssessed: number
    incompleteDefinitions: number
    imperativeDefinitions: number
    declarativeDefinitions: number
    limitsReached: string[]
    sourceSelection?: {
      eligibleFiles: number
      selectedFiles: number
      skippedFiles: number
      scannedBytes?: number
      skippedByReason: Record<string, number>
      limits: Record<string, number>
      limitsReached: string[]
    }
    toolCounts: { byKind: Record<string, number>; byBehavior: Record<string, number> }
    exposurePosture: Record<string, number>
    confirmationPosture: Record<string, number>
    findingsByControl: Record<string, number>
    findingsBySeverity: Record<string, number>
    representativeRemediation: Array<{
      controlId: string
      severity: string
      text: string
    }>
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

function getSnapshotWebMcpAssurance(contentJson: unknown): ShareableReport["webMcpAssurance"] {
  if (!contentJson || typeof contentJson !== "object" || Array.isArray(contentJson)) return null
  const snapshot = contentJson as Record<string, unknown>
  return parseWebMcpAssurance(snapshot.webMcpAssurance)
}

/**
 * A report's persisted scan link is the authorization source. A snapshot that
 * names a different scan must never be returned through that link, even when
 * the snapshot itself otherwise parses. Historical rows without an explicit
 * scanInfo binding remain readable through their separately validated scan link.
 */
export function reportSnapshotScanBindingMatches(
  contentJson: unknown,
  scanId: string | null,
  type: string,
  options: { requireExplicit?: boolean; launchPayloadValid?: boolean } = {}
): boolean {
  if (type === "launch_readiness") {
    return options.launchPayloadValid ?? true
  }
  if (contentJson === null || contentJson === undefined) return !options.requireExplicit
  if (!contentJson || typeof contentJson !== "object" || Array.isArray(contentJson)) return false
  if (!Object.hasOwn(contentJson, "scanInfo")) return !options.requireExplicit
  const scanInfo = (contentJson as Record<string, unknown>).scanInfo
  if (scanInfo === null) return !options.requireExplicit && scanId === null
  if (!scanInfo || typeof scanInfo !== "object" || Array.isArray(scanInfo)) return false
  const snapshotScanId = (scanInfo as Record<string, unknown>).scanId
  return typeof snapshotScanId === "string" && snapshotScanId === scanId
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

export async function createReport(
  params: CreateReportParams
): Promise<Report & { snapshotReused?: boolean }> {
  const type =
    params.type === "executive" || params.type === "compliance" ? params.type : "developer"
  const db = params.client ?? prisma

  // W3-05: one private snapshot per scan+type. Duplicate completion events or
  // a retried creation return the existing snapshot instead of gathering a
  // second one — and never touch the scan, so a retry can never replay or
  // re-enqueue billable work.
  if (params.scanId && !params.requireActiveTarget) {
    const existing = await db.report.findFirst({
      where: { workspaceId: params.workspaceId, scanId: params.scanId, type, deletedAt: null },
      orderBy: { createdAt: "asc" },
    })
    if (existing) {
      logger.info("Report snapshot reused for scan+type", {
        reportId: existing.id,
        workspaceId: params.workspaceId,
      })
      return { ...existing, snapshotReused: true }
    }
  }

  const contentJson = await gatherReportData(params.workspaceId, params.scanId, type, params.client)
  const persist = (client: Pick<typeof prisma, "report">) =>
    client.report.create({
      data: {
        workspaceId: params.workspaceId,
        ...(params.scanId ? { scanId: params.scanId } : {}),
        type,
        title: params.title,
        status: "generated",
        format: "html",
        createdById: params.createdById,
        contentJson,
      },
    })
  const persistInTransaction = async (tx: ScopedTransaction) => {
    if (params.requireActiveTarget) {
      const targetExists = params.client
        ? Boolean(
            params.targetId &&
            (await tx.target.findFirst({
              where: {
                id: params.targetId,
                workspaceId: params.workspaceId,
                deletedAt: null,
              },
              select: { id: true },
            }))
          )
        : Boolean(
            params.targetId &&
            (await lockActiveTargetForDerivedWrite(tx, params.workspaceId, params.targetId))
          )
      if (!targetExists) {
        throw new Error("FORBIDDEN")
      }
      if (params.scanId) {
        const scan = await tx.scan.findFirst({
          where: {
            id: params.scanId,
            workspaceId: params.workspaceId,
            targetId: params.targetId,
            deletedAt: null,
            target: { workspaceId: params.workspaceId, deletedAt: null },
          },
          select: { id: true },
        })
        if (!scan) throw new Error("SCAN_NOT_FOUND")
      }
    }
    if (params.scanId) {
      // Serialize snapshot writers without deleting historical duplicates.
      const identity = JSON.stringify([params.workspaceId, params.scanId, type])
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`
      const existing = await tx.report.findFirst({
        where: { workspaceId: params.workspaceId, scanId: params.scanId, type, deletedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
      if (existing) return { ...existing, snapshotReused: true }
    }
    return persist(tx)
  }
  const report = params.client
    ? await persistInTransaction(params.client)
    : params.scanId || params.requireActiveTarget
      ? await withWorkspaceRLS(params.workspaceId, persistInTransaction)
      : await persist(prisma)

  logger.info("Report created", { reportId: report.id, workspaceId: params.workspaceId })
  return report
}

export async function getReportByShareToken(
  token: string
): Promise<Pick<Report, "id" | "workspaceId" | "shareExpiresAt"> | null> {
  if (!SHARE_TOKEN_PATTERN.test(token)) return null

  const tokenHash = createHash("sha256").update(token).digest("hex")

  const report = await getSystemPrisma().report.findFirst({
    where: { shareTokenHash: tokenHash, revokedAt: null, deletedAt: null },
    select: { id: true, workspaceId: true, shareExpiresAt: true },
  })

  if (!report) return null

  if (report.shareExpiresAt && report.shareExpiresAt < new Date()) {
    logger.warn("Share token expired", { reportId: report.id })
    return null
  }

  return report
}

/** A locator grants no access: bind capability and DB time to the content SELECT. */
export async function readActiveSharedReport(
  tx: ScopedTransaction,
  workspaceId: string,
  reportId: string,
  token: string
): Promise<Report | null> {
  const tokenHash = createHash("sha256").update(token).digest("hex")
  const rows = await tx.$queryRaw<Report[]>`
    SELECT * FROM "Report"
    WHERE "id" = ${reportId} AND "workspaceId" = ${workspaceId}
      AND "shareTokenHash" = ${tokenHash} AND "revokedAt" IS NULL AND "deletedAt" IS NULL
      AND ("shareExpiresAt" IS NULL OR "shareExpiresAt" > (statement_timestamp() AT TIME ZONE 'UTC'))
    LIMIT 1`
  return rows[0] ?? null
}

/** Compare the private snapshot without carrying its raw contents beyond an RLS read. */
export function sharedReportSnapshotBinding(
  report: Pick<Report, "type" | "scanId" | "contentJson" | "provenanceJson">
): string {
  return createHash("sha256")
    .update(JSON.stringify([report.type, report.scanId, report.contentJson, report.provenanceJson]))
    .digest("hex")
}

/** Fresh READ COMMITTED capability check immediately before returning a public result. */
export async function sharedReportStillActive(
  workspaceId: string,
  reportId: string,
  token: string,
  snapshotBinding: string
): Promise<boolean> {
  return withWorkspaceRLS(
    workspaceId,
    async (tx) => {
      const current = await readActiveSharedReport(tx, workspaceId, reportId, token)
      return current !== null && sharedReportSnapshotBinding(current) === snapshotBinding
    },
    { isolationLevel: "ReadCommitted" }
  )
}

export async function getShareableReport(
  reportId: string,
  workspaceId: string,
  options: {
    requireExplicitSnapshotBinding?: boolean
    allowedProfiles?: string[]
    client?: ScopedTransaction
  } = {}
): Promise<ShareableReport | null> {
  return readShareableReport(reportId, workspaceId, undefined, false, options)
}

/** Revalidate the public capability in the same transaction as the content read. */
export async function getShareableReportByToken(
  reportId: string,
  workspaceId: string,
  token: string
): Promise<ShareableReport | null> {
  return readShareableReport(reportId, workspaceId, token, true)
}

async function readShareableReport(
  reportId: string,
  workspaceId: string,
  shareToken?: string,
  allowLaunchMetadata = false,
  options: {
    requireExplicitSnapshotBinding?: boolean
    allowedProfiles?: string[]
    client?: ScopedTransaction
  } = {}
): Promise<ShareableReport | null> {
  // Public share path: no request-scoped workspace context is set, so the Prisma
  // extension does not inject RLS context on its own. "Report", "Scan" and
  // "Finding" are all under FORCE ROW LEVEL SECURITY, which makes the database
  // policy the real isolation boundary — the explicit workspaceId predicates
  // below are defence-in-depth, not a substitute. Wrapping the whole read
  // sequence keeps `SET LOCAL` and every query on one connection. (S4)
  const read = async (tx: ScopedTransaction) => {
    const report = shareToken
      ? await readActiveSharedReport(tx, workspaceId, reportId, shareToken)
      : await tx.report.findFirst({ where: { id: reportId, workspaceId, deletedAt: null } })

    // Release packets have their own permission-checked readers; never project
    // their linked scan or snapshot into a generic report, even with a valid token.
    if (!report || report.type === "release_packet") return null
    if (
      !reportSnapshotScanBindingMatches(report.contentJson, report.scanId, report.type, {
        requireExplicit: options.requireExplicitSnapshotBinding,
        launchPayloadValid:
          options.requireExplicitSnapshotBinding && report.type === "launch_readiness"
            ? isLaunchReportShareablePayload(report.contentJson)
            : undefined,
      })
    ) {
      return null
    }
    if (options.requireExplicitSnapshotBinding && report.scanId) {
      const activeBinding = await tx.scan.findFirst({
        where: {
          id: report.scanId,
          workspaceId,
          deletedAt: null,
          target: { workspaceId, deletedAt: null },
          ...(options.allowedProfiles !== undefined
            ? { mode: { in: options.allowedProfiles as never[] } }
            : {}),
        },
        select: { id: true },
      })
      if (!activeBinding) return null
    }
    // A malformed launch payload cannot fall back to the generic share view.
    if (shareToken && report.type === "launch_readiness") {
      if (!allowLaunchMetadata || !isLaunchReportShareablePayload(report.contentJson)) return null
    }

    let scanSummary: ShareableReport["scanSummary"] =
      getSnapshotScanSummary(report.contentJson) ?? null

    if (report.scanId && !scanSummary) {
      // Only these three fields are used below: the finding count comes from the
      // groupBy (not from a `_count` subquery), and the target name is
      // deliberately replaced with "Private target" on this public path — so
      // neither relation is fetched.
      const scan = await tx.scan.findFirst({
        where: { id: report.scanId, workspaceId, deletedAt: null },
        select: { id: true, status: true, summary: true },
      })

      if (scan) {
        const severityGroups = await tx.finding.groupBy({
          by: ["severity"],
          where: {
            workspaceId,
            deletedAt: null,
            candidates: { some: { scanId: scan.id } },
          },
          _count: { _all: true },
        })

        const bySeverity: Record<string, number> = {}
        let findingsCount = 0
        for (const g of severityGroups) {
          bySeverity[g.severity] = g._count._all
          findingsCount += g._count._all
        }

        scanSummary = {
          scanId: scan.id,
          status: scan.status,
          summary: scan.summary,
          targetName: "Private target",
          findingsCount,
          findingsBySeverity: bySeverity,
        }
      }
    }

    const shareable: ShareableReport = {
      id: report.id,
      title:
        report.type === "launch_readiness"
          ? "LyraShield Launch Readiness Report"
          : "LyraShield Security Assurance Report",
      type: report.type,
      status: report.status,
      format: report.format,
      shareUrl: report.shareTokenHash ? `/reports/shared/${report.id}` : null,
      shareExpiresAt: report.shareExpiresAt,
      revokedAt: report.revokedAt,
      createdAt: report.createdAt,
      scanSummary,
      assurance: getSnapshotAssurance(report.contentJson),
      webMcpAssurance: getSnapshotWebMcpAssurance(report.contentJson),
    }
    return { shareable, binding: shareToken ? sharedReportSnapshotBinding(report) : null }
  }
  const result = options.client
    ? await read(options.client)
    : await withWorkspaceRLS(
        workspaceId,
        read,
        shareToken ? { isolationLevel: "RepeatableRead" } : undefined
      )

  if (!result) return null
  if (
    shareToken &&
    (!result.binding ||
      !(await sharedReportStillActive(workspaceId, reportId, shareToken, result.binding)))
  )
    return null
  return result.shareable
}

/**
 * Resolve the persisted target a report is bound to, for delegated-scope
 * authorization (W0.3). Returns:
 * - `null` when the report does not exist in the workspace (callers 404),
 * - `{ targetId }` when the persisted binding resolves to one target,
 * - `{ targetId: null }` when no single persisted target can be proven —
 *   workspace-wide scans, deleted scan/target rows, legacy launch reports
 *   without parseable provenance, and provenance contradicted by the stored
 *   verdict all land here. Callers MUST treat that as "requires an
 *   all-targets grant", never as "no check": assertOAuthDelegatedScope
 *   already denies unbound targets for narrowed connections.
 *
 * The request body is never consulted — attribution comes only from stored
 * rows (the linked scan's target, or the launch report's provenance-verified
 * gate verdict), so a caller cannot steer the check toward a covered target.
 *
 * Pass `client` to resolve the binding inside an existing RLS transaction so
 * the authorization check and the content read share one snapshot. Pass
 * `withProfile` when the caller also enforces profile-scoped grants.
 */
export async function resolveReportDelegationTarget(
  reportId: string,
  workspaceId: string,
  options: {
    requireExplicitSnapshotBinding?: boolean
    allowedProfiles?: string[]
    client?: ScopedTransaction
    withProfile?: boolean
  } = {}
): Promise<{ targetId: string | null; profile?: string | null } | null> {
  // Same isolation boundary as getShareableReport: Report/Scan/GateVerdict are
  // under FORCE ROW LEVEL SECURITY, so the transaction-local workspace context
  // is the real boundary and the explicit predicates are defence-in-depth.
  const read = async (tx: ScopedTransaction) => {
    const report = await tx.report.findFirst({
      where: { id: reportId, workspaceId, deletedAt: null },
      select: { id: true, scanId: true, type: true, provenanceJson: true, contentJson: true },
    })
    if (!report) return null

    if (report.scanId) {
      if (
        !reportSnapshotScanBindingMatches(report.contentJson, report.scanId, report.type, {
          requireExplicit: options.requireExplicitSnapshotBinding,
        })
      ) {
        return null
      }
      const scan = await tx.scan.findFirst({
        where: {
          id: report.scanId,
          workspaceId,
          deletedAt: null,
          ...(options.allowedProfiles !== undefined
            ? { mode: { in: options.allowedProfiles as never[] } }
            : {}),
        },
        select: { targetId: true, ...(options.withProfile ? { mode: true } : {}) },
      })
      // Deleted scan, or a workspace-wide scan with no persisted target:
      // unattributable → all-targets only.
      const target = scan as { targetId: string | null; mode?: string | null } | null
      return options.withProfile
        ? { targetId: target?.targetId ?? null, profile: target?.mode ?? null }
        : { targetId: target?.targetId ?? null }
    }

    if (report.type === "launch_readiness") {
      if (
        !reportSnapshotScanBindingMatches(report.contentJson, null, report.type, {
          requireExplicit: options.requireExplicitSnapshotBinding,
          launchPayloadValid: isLaunchReportShareablePayload(report.contentJson),
        })
      ) {
        return null
      }
      // Launch reports bind a target only through issue-time provenance, and
      // only when the stored verdict still carries the recorded checksum — a
      // contradiction means the binding cannot be proven.
      const provenance = parseLaunchReportProvenance(report.provenanceJson)
      if (!provenance)
        return options.withProfile ? { targetId: null, profile: null } : { targetId: null }
      const verdict = await tx.gateVerdict.findFirst({
        where: {
          id: provenance.gateVerdictId,
          workspaceId,
          ...(options.requireExplicitSnapshotBinding
            ? { target: { workspaceId, deletedAt: null } }
            : {}),
        },
        select: { targetId: true, verdictChecksum: true },
      })
      if (!verdict || verdict.verdictChecksum !== provenance.verdictChecksum) {
        return options.withProfile ? { targetId: null, profile: null } : { targetId: null }
      }
      return options.withProfile
        ? { targetId: verdict.targetId, profile: null }
        : { targetId: verdict.targetId }
    }

    // No scan link and not a launch report: provenance on other report types
    // is not a delegation binding.
    return options.withProfile ? { targetId: null, profile: null } : { targetId: null }
  }
  return options.client ? read(options.client) : withWorkspaceRLS(workspaceId, read)
}

export { listReports, type ReportListItem } from "./report-list-service"
