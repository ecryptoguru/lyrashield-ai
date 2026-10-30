import type { Prisma, Report } from "./generated/prisma"
import { withWorkspaceRLS, type ScopedTransaction } from "./rls"
import {
  parseLaunchReportProvenance,
  type LaunchReportProvenance,
} from "./launch-report-provenance"

/** Resolve immutable launch bindings before selecting the requested report page. */
async function reportTargetWhere(
  tx: ScopedTransaction,
  workspaceId: string,
  targetIds: string[]
): Promise<Prisma.ReportWhereInput> {
  const bindings = await tx.report.findMany({
    where: { workspaceId, deletedAt: null, scanId: null, type: "launch_readiness" },
    select: { id: true, provenanceJson: true },
  })
  const parsed = bindings.flatMap((report) => {
    const provenance = parseLaunchReportProvenance(report.provenanceJson)
    return provenance ? [{ id: report.id, provenance }] : []
  })
  const verdicts = parsed.length
    ? await tx.gateVerdict.findMany({
        where: {
          workspaceId,
          targetId: { in: targetIds },
          id: { in: [...new Set(parsed.map((row) => row.provenance.gateVerdictId))] },
        },
        select: { id: true, verdictChecksum: true },
      })
    : []
  const checksums = new Map(verdicts.map((verdict) => [verdict.id, verdict.verdictChecksum]))
  const ids = parsed
    .filter((row) => checksums.get(row.provenance.gateVerdictId) === row.provenance.verdictChecksum)
    .map((row) => row.id)
  return {
    OR: [
      { scan: { workspaceId, deletedAt: null, targetId: { in: targetIds } } },
      { id: { in: ids }, scanId: null, type: "launch_readiness" },
    ],
  }
}

/**
 * List-view projection for a report row. `contentJson` holds the entire
 * generated report body (assurance data, score trends, finding summaries) and
 * `storageUri` is only needed on download — neither is rendered in the list, so
 * projecting them away keeps this request from moving hundreds of KB per page
 * load. Single-report reads go through getShareableReport/generateReport.
 */
const REPORT_LIST_SELECT = {
  id: true,
  title: true,
  type: true,
  status: true,
  format: true,
  scanId: true,
  shareTokenHash: true,
  shareExpiresAt: true,
  revokedAt: true,
  createdAt: true,
  // Private issue-time provenance — small JSON, launch_readiness rows only.
  // This list endpoint is authenticated-only; the shared/public readers never
  // touch it.
  provenanceJson: true,
} as const

export type ReportListItem = Pick<
  Report,
  | "id"
  | "title"
  | "type"
  | "status"
  | "format"
  | "scanId"
  | "shareTokenHash"
  | "shareExpiresAt"
  | "revokedAt"
  | "createdAt"
> & {
  /**
   * Parsed private provenance for launch_readiness reports (null for other
   * types or when the stored record predates the binding / is unparseable).
   * Authenticated consumers only.
   */
  provenance: LaunchReportProvenance | null
}

export async function listReports(
  workspaceId: string,
  cursor?: string,
  limit?: number,
  targetIds?: string[]
): Promise<{
  items: ReportListItem[]
  nextCursor: string | null
}> {
  if (targetIds?.length === 0) return { items: [], nextCursor: null }
  const lim = Math.min(Math.max(limit ?? 50, 1), 100)

  // "Report" is under FORCE ROW LEVEL SECURITY, so the transaction-local context
  // is the isolation boundary — the workspaceId predicate alone is not.
  const reports = await withWorkspaceRLS(workspaceId, async (tx) => {
    const targetWhere =
      targetIds !== undefined ? await reportTargetWhere(tx, workspaceId, targetIds) : {}
    return tx.report.findMany({
      where: { workspaceId, deletedAt: null, ...targetWhere },
      orderBy: { createdAt: "desc" },
      take: lim + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: REPORT_LIST_SELECT,
    })
  })

  const hasMore = reports.length > lim
  const rows = hasMore ? reports.slice(0, lim) : reports
  const items: ReportListItem[] = rows.map((report) => {
    const { provenanceJson, ...rest } = report
    return {
      ...rest,
      provenance:
        report.type === "launch_readiness" ? parseLaunchReportProvenance(provenanceJson) : null,
    }
  })
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

  return { items, nextCursor }
}
