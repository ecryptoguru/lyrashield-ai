/**
 * `review_scan_report` — the reports page's WebMCP tool definition.
 *
 * Page-scoped read: identifiers resolve only against the reports currently
 * visible in the page's own list; the workspace is bound at registration and
 * can never arrive as agent input. The handler performs the same
 * authenticated `GET /api/reports/:id` read the page uses — a strictly
 * read-only path that never creates a report or a public link.
 *
 * Output is a bounded metadata + summary projection: report metadata, the
 * server-side scan/assurance summary counts, and launch provenance when the
 * report type carries it. Raw storage URIs, share links, signed URLs,
 * narratives and report content are never forwarded.
 */
import { apiGet } from "@/lib/api-client"
import { redactEmbeddedUrls } from "@/lib/webmcp/output"
import type { WebMcpInputSchema, WebMcpPageTool } from "@/lib/webmcp/register"
import {
  shareableReportSchema,
  type LaunchReportProvenance,
  type ReportItem,
  type ShareableReport,
} from "./reports-model"

/**
 * Inputs the tool must never accept from an agent: tenancy, principals,
 * foreign resource ids and secret-shaped keys. `reportId`/`scanId` are
 * legitimate — they resolve against the page's own visible list.
 */
export const REPORTS_WEBMCP_FORBIDDEN_INPUT_KEYS = [
  "workspaceId",
  "workspace",
  "userId",
  "user",
  "targetId",
  "evidence",
  "secret",
] as const

const reportInputSchema: WebMcpInputSchema = {
  properties: {
    reportId: {
      type: "string",
      description: "Visible report id.",
    },
    scanId: {
      type: "string",
      description: "Visible report's scan id.",
    },
  },
}

/** Resolve an optional agent-supplied identifier against the page's own
 * visible report list — never a foreign or server-side id space. */
export function resolveVisibleReport(
  reports: ReportItem[],
  input: { reportId?: string; scanId?: string }
): ReportItem {
  if (reports.length === 0) {
    throw new Error("No reports are visible on this page yet.")
  }
  const { reportId, scanId } = input
  if (reportId && scanId) {
    const row = reports.find((report) => report.id === reportId && report.scanId === scanId)
    if (!row) {
      throw new Error(
        `Report "${reportId}" and scan "${scanId}" do not name the same visible report.`
      )
    }
    return row
  }
  if (reportId) {
    const row = reports.find((report) => report.id === reportId)
    if (!row) throw new Error(`Report "${reportId}" is not currently visible on this page.`)
    return row
  }
  if (scanId) {
    const row = reports.find((report) => report.scanId === scanId)
    if (!row) {
      throw new Error(`Scan "${scanId}" is not currently visible on this page.`)
    }
    return row
  }
  // No identifier → the newest visible report (the list is sorted desc).
  return reports[0]!
}

export interface ScanReportOutput {
  reportId: string
  title: string
  type: string
  status: string
  format: string
  createdAt: string
  /** True when a live (unexpired, unrevoked) share exists — link itself omitted. */
  shared: boolean
  shareExpiresAt: string | null
  scan: {
    scanId: string
    status: string
    findingsCount: number
    findingsBySeverity: Record<string, number>
    summary: string | null
  } | null
  assurance: {
    verdict: string
    score: number | null
    grade: string | null
    verifiedCount: number
    fixedCount: number
    retestSummary: { passed: number; failed: number; pending: number }
  } | null
  launch: {
    verdictLabel: string | null
    stale: boolean | null
    applicability: LaunchReportProvenance["applicability"] | null
    historicalState: string | null
    effectiveState: string | null
    assessedIdentity: { kind: string; value: string } | null
    reasonCodes: string[] | null
    assessedAt: string | null
    issuedAt: string | null
  } | null
  note: string
}

const MAX_ECHO_TEXT = 160
const MAX_REASON_CODES = 4

/**
 * Project the shareable-report payload into the bounded tool result. Only
 * metadata and summary counts survive — never `shareUrl`, `storageUri`,
 * `contentJson`, narratives or anything URL-shaped.
 */
export function buildScanReportOutput(row: ReportItem, detail: ShareableReport): ScanReportOutput {
  const launchProvenance =
    detail.launchReport?.provenance ??
    (row.type === "launch_readiness" ? (row.provenance ?? null) : null)

  return {
    reportId: row.id,
    title: redactEmbeddedUrls(row.title, MAX_ECHO_TEXT),
    type: detail.type,
    status: detail.status,
    format: detail.format,
    createdAt: detail.createdAt,
    // A share flag is enough — the link itself is never a tool result.
    shared: Boolean(detail.shareExpiresAt && !detail.revokedAt),
    shareExpiresAt: detail.shareExpiresAt ?? null,
    scan: detail.scanSummary
      ? {
          scanId: detail.scanSummary.scanId,
          status: detail.scanSummary.status,
          findingsCount: detail.scanSummary.findingsCount,
          findingsBySeverity: detail.scanSummary.findingsBySeverity,
          summary: detail.scanSummary.summary
            ? redactEmbeddedUrls(detail.scanSummary.summary, MAX_ECHO_TEXT)
            : null,
        }
      : null,
    assurance: detail.assurance
      ? {
          verdict: detail.assurance.verdict,
          score: detail.assurance.score,
          grade: detail.assurance.grade,
          verifiedCount: detail.assurance.verifiedCount,
          fixedCount: detail.assurance.fixedCount,
          retestSummary: detail.assurance.retestSummary,
        }
      : null,
    launch:
      detail.launchReport || launchProvenance
        ? {
            verdictLabel: detail.launchReport?.verdictLabel ?? null,
            stale: detail.launchReport?.stale ?? null,
            applicability: launchProvenance?.applicability ?? null,
            historicalState: launchProvenance?.historicalState ?? null,
            effectiveState: launchProvenance?.effectiveState ?? null,
            assessedIdentity: launchProvenance?.assessedIdentity
              ? {
                  kind: launchProvenance.assessedIdentity.kind,
                  value: launchProvenance.assessedIdentity.value.slice(0, 80),
                }
              : null,
            reasonCodes: launchProvenance
              ? launchProvenance.reasonCodes.slice(0, MAX_REASON_CODES)
              : null,
            assessedAt: launchProvenance?.assessedAt ?? null,
            issuedAt: launchProvenance?.issuedAt ?? null,
          }
        : null,
    note: "Metadata and bounded summary only — the report document, share links and evidence locations are never returned. Reading does not create a report or a public link.",
  }
}

/** The `review_scan_report` registration options minus the receipt store. */
export function createReviewScanReportTool(deps: {
  workspaceId: string
  /** The reports currently visible in the page's own list. */
  getReports: () => ReportItem[]
}): WebMcpPageTool<{ reportId?: string; scanId?: string }> {
  return {
    name: "review_scan_report",
    title: "Review scan report",
    description:
      "Read bounded metadata and summary for a report visible on this page. Never returns report content, links, or evidence locations.",
    inputSchema: reportInputSchema,
    classification: "read",
    dataClass: "workspace-summary",
    // Titles and summaries are user/engine-emitted text — untrusted content.
    untrustedContent: true,
    uiChanged: false,
    durableMutation: false,
    humanConfirmationRequired: false,
    forbiddenInputKeys: REPORTS_WEBMCP_FORBIDDEN_INPUT_KEYS,
    receiptProjection: (result) => {
      const resolved = result as ScanReportOutput
      return {
        references: {
          reportId: resolved.reportId,
          ...(resolved.scan?.scanId ? { scanId: resolved.scan.scanId } : {}),
        },
        href: "/dashboard/reports",
      }
    },
    handler: async (input, { signal }) => {
      const row = resolveVisibleReport(deps.getReports(), input)
      // The page's own authenticated read — a strictly read-only path.
      const detail = await apiGet<ShareableReport>(
        `/api/reports/${encodeURIComponent(row.id)}?workspaceId=${encodeURIComponent(
          deps.workspaceId
        )}`,
        { signal, schema: shareableReportSchema }
      )
      return buildScanReportOutput(row, detail)
    },
  }
}
