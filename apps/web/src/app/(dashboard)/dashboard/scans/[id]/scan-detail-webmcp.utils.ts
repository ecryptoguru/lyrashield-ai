/**
 * `review_scan_progress` — the scan-detail page's WebMCP tool definition.
 *
 * The tool is a page-scoped read: it resolves only the scan the page is
 * displaying (the workspace and scan id are bound at registration, never from
 * agent input), then reads the same authenticated endpoints the page itself
 * uses — the status poll (`GET /api/scans/:id`) and the one-time quality
 * surface (`GET /api/scans/:id/quality`, the getScanQuality path).
 *
 * Honesty contract: everything returned derives from recorded events and
 * stored receipts. No percent-complete or ETA is ever synthesized — absent
 * fields are reported absent (`null`, and the `notReported` list). URLs are
 * stripped even when they appear inside engine-emitted text, so results never
 * carry evidence locations or signed links.
 */
import { apiGet } from "@/lib/api-client"
import { scanPollDataSchema } from "@/lib/api-schemas"
import { estimateRunMinutes } from "@/lib/estimator"
import { ScanQualitySurfaceSchema, type ScanQualitySurfaceResponse } from "@lyrashield/types"
import { redactEmbeddedUrls } from "@/lib/webmcp/output"
import type { WebMcpInputSchema, WebMcpPageTool } from "@/lib/webmcp/register"
import { INTERNAL_ACCOUNTING_EVENT_STAGES } from "./scan-detail-presentation"
import type { ScanPollData } from "./scan-detail-types"
import { deriveCurrentStage, derivePhases } from "./scan-detail-utils"

/**
 * Inputs the tool must never accept from an agent: tenancy, principals,
 * foreign resource ids and secret-shaped keys. `scanId` is legitimate — it is
 * resolved against the page's own displayed scan.
 */
export const SCAN_DETAIL_WEBMCP_FORBIDDEN_INPUT_KEYS = [
  "workspaceId",
  "workspace",
  "userId",
  "user",
  "targetId",
  "evidence",
  "secret",
] as const

const progressInputSchema: WebMcpInputSchema = {
  properties: {
    scanId: {
      type: "string",
      description: "Scan id shown on this page.",
    },
  },
}

export interface ScanProgressOutput {
  scanId: string
  status: string
  goal: string
  mode: string
  currentStage: string
  steps: { label: string; state: string }[]
  elapsedSeconds: number | null
  startedAt: string | null
  endedAt: string | null
  queuePosition: { position: number; waiting: number } | null
  counts: {
    events: number
    coverageReceipts: number | null
    findings: number | null
    verifiedFindings: number | null
  }
  evidence: {
    manifestPresent: boolean | null
    manifestChecksum: string | null
    ingestionWarnings: number | null
    attachments: number | null
    receiptsByStatus: Record<string, number> | null
  }
  /** The page's own static per-mode estimate — never derived from progress. */
  estimatedMinutes: { low: number; high: number }
  error: { category: string | null; message: string | null } | null
  /** Fields the API does not carry — reported absent instead of invented. */
  notReported: string[]
  note: string
}

const MAX_ECHO_TEXT = 160

function asIsoString(value: string | Date | null): string | null {
  if (value === null) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * Project the poll + quality payloads into the bounded tool result. Pure —
 * the same inputs always produce the same output for a given `now`.
 */
export function buildScanProgressOutput(input: {
  poll: ScanPollData
  quality: ScanQualitySurfaceResponse | null
  now?: number
}): ScanProgressOutput {
  const { poll, quality } = input
  const now = input.now ?? Date.now()

  // Same internal-stage filtering the page applies before deriving the
  // visible stage, so the agent reads exactly what the user sees.
  const displayEvents = (poll.events ?? []).filter(
    (event) => !INTERNAL_ACCOUNTING_EVENT_STAGES.has(event.stage)
  )

  const startedMs = poll.startedAt ? new Date(poll.startedAt).getTime() : null
  const endedMs = poll.endedAt ? new Date(poll.endedAt).getTime() : null
  const elapsedSeconds =
    startedMs !== null && Number.isFinite(startedMs)
      ? Math.max(0, Math.round(((endedMs ?? now) - startedMs) / 1000))
      : null

  const errorMessage = poll.errorMessage?.trim()
    ? redactEmbeddedUrls(poll.errorMessage, MAX_ECHO_TEXT)
    : null

  return {
    scanId: poll.id,
    status: poll.status,
    goal: poll.goal,
    mode: poll.mode,
    currentStage: redactEmbeddedUrls(deriveCurrentStage(poll.status, displayEvents), MAX_ECHO_TEXT),
    steps: derivePhases(poll.status, displayEvents).map((phase) => ({
      label: phase.label,
      state: phase.state,
    })),
    elapsedSeconds,
    startedAt: asIsoString(poll.startedAt),
    endedAt: asIsoString(poll.endedAt),
    queuePosition: poll.queuePosition ?? null,
    counts: {
      events: displayEvents.length,
      coverageReceipts:
        poll.coverageReceipts?.length ?? quality?.facts.coverage.receiptsTotal ?? null,
      findings: quality?.facts.findings.total ?? null,
      verifiedFindings: quality?.facts.findings.verifiedCount ?? null,
    },
    evidence: {
      manifestPresent:
        quality?.facts.evidence.manifestPresent ?? Boolean(poll.resultManifest?.checksum),
      manifestChecksum:
        quality?.facts.evidence.manifestChecksum ?? poll.resultManifest?.checksum ?? null,
      ingestionWarnings: quality?.facts.evidence.ingestionWarningCount ?? null,
      attachments: quality?.facts.evidence.attachmentCount ?? null,
      receiptsByStatus: quality?.facts.coverage.byStatus ?? null,
    },
    estimatedMinutes: estimateRunMinutes(poll.mode),
    error:
      poll.errorCategory || errorMessage
        ? { category: poll.errorCategory, message: errorMessage }
        : null,
    notReported: ["percentComplete", "etaSeconds"],
    note: "Progress reflects recorded events and stored receipts only — no percent-complete or ETA is estimated. Open the scan for the full timeline.",
  }
}

/** The `review_scan_progress` registration options minus the receipt store. */
export function createReviewScanProgressTool(deps: {
  workspaceId: string
  /** The scan id this page is currently displaying. */
  getScanId: () => string
}): WebMcpPageTool<{ scanId?: string }> {
  return {
    name: "review_scan_progress",
    title: "Review scan progress",
    description:
      "Read the displayed scan's live status, recorded steps, elapsed time and evidence counts. Read-only; no percent or ETA is estimated.",
    inputSchema: progressInputSchema,
    classification: "read",
    dataClass: "workspace-summary",
    // Stage labels derive from engine-emitted event text — untrusted content.
    untrustedContent: true,
    uiChanged: false,
    durableMutation: false,
    humanConfirmationRequired: false,
    forbiddenInputKeys: SCAN_DETAIL_WEBMCP_FORBIDDEN_INPUT_KEYS,
    receiptProjection: (result) => {
      const resolved = result as ScanProgressOutput
      return {
        references: { scanId: resolved.scanId },
        href: `/dashboard/scans/${resolved.scanId}`,
      }
    },
    handler: async (input, { signal }) => {
      const pageScanId = deps.getScanId()
      if (input.scanId && input.scanId !== pageScanId) {
        throw new Error(
          `Scan "${input.scanId}" is not currently visible on this page. Open its detail page first.`
        )
      }
      const encodedWorkspace = encodeURIComponent(deps.workspaceId)
      const encodedScan = encodeURIComponent(pageScanId)

      // The page's own read paths: the poll endpoint it polls and the
      // one-time quality surface. The poll payload is authoritative; the
      // quality read degrades to absent fields rather than failing the tool.
      const [pollResult, qualityResult] = await Promise.allSettled([
        apiGet<ScanPollData>(`/api/scans/${encodedScan}?workspaceId=${encodedWorkspace}`, {
          signal,
          schema: scanPollDataSchema,
        }),
        apiGet<ScanQualitySurfaceResponse>(
          `/api/scans/${encodedScan}/quality?workspaceId=${encodedWorkspace}`,
          { signal, schema: ScanQualitySurfaceSchema }
        ),
      ])
      if (pollResult.status === "rejected") throw pollResult.reason
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      const quality = qualityResult.status === "fulfilled" ? qualityResult.value : null

      return buildScanProgressOutput({ poll: pollResult.value, quality })
    },
  }
}
