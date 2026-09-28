"use client"
import { useState, useEffect, useCallback, useRef } from "react"
import { z } from "zod"
import Link from "next/link"
import { Shield, ChevronRight, CheckCircle2, AlertCircle, ArrowRight } from "lucide-react"
import { Button, Badge, cn } from "@lyrashield/ui"
import { apiGet, apiPost, apiPatch } from "@/lib/api-client"
import { SEVERITY_BADGE } from "@/lib/severity-badge"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { severityLabel, humanizeToken } from "@/lib/labels"
import { findingsHref } from "@/lib/finding-list-params"
import { FINDING_STATUS_LABELS, getVerificationStatusLabel } from "@/lib/enum-labels"
import {
  STATUS_BADGE,
  SEVERITY_ICON,
  SEVERITY_COLOR,
  extractEpssPercentage,
} from "./finding-presentation"
import type { FindingListItem } from "./findings-client"
import { FindingTechnicalTab, FindingHistoryTab } from "./finding-detail-tabs"
import { FindingActionTab, type AudienceMode } from "./finding-action-tab"

// ---------------------------------------------------------------------------
// Audience mode — client-side reframing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Finding detail types
// ---------------------------------------------------------------------------

interface PlainLanguage {
  title: string
  whatItIs: string
  whyItMatters: string
  howToFix: string
  difficulty: string
  estimatedTimeToFix: string
}

export interface FindingDetail {
  id: string
  title: string
  summary: string
  category?: string | null
  cwe?: string | null
  cvssScore?: number | null
  technicalDetail?: string | null
  recommendedFix?: string | null
  businessImpact?: string | null
  exploitability?: string | null
  verificationStatus?: string
  verificationMethod?: string | null
  verificationReason?: string | null
  statusReason?: string | null
  verificationReceipts?: Array<{
    id: string
    status: string
    method: string
    reason: string
    scanId: string
    sourceRevision: string | null
    verifierVersion: string | null
    evidence: unknown
    createdAt: string
  }>
  evidence?: Array<{ id: string; type: string; redactionStatus: string }>
  /** Engine-declared claim context — assertions, never app verification. */
  evidenceInsights?: {
    counterevidence?: string
    evidenceWarnings?: string[]
    severityChangeConditions?: string
    assumptions?: string
    confidenceRationale?: string
    contextualCvssReasoning?: string
    advisoryCvss?: {
      score: number
      vector?: string
      source?: string
      metric_reasoning?: string
    }
    engineVerificationState?: string
    engineConfidence?: string
  } | null
  fixProposals?: Array<{
    id: string
    status: string
    summary: string
    createdAt?: string
    pullRequests?: Array<{
      id: string
      status: string
      prNumber: number | null
      prUrl: string | null
      branchName: string
      createdAt: string
      mergedAt: string | null
      closedAt: string | null
    }>
  }>
  retests?: Array<{ id: string; scanId: string; status: string; createdAt: string }>
  historyPagination?: Record<
    "evidence" | "verificationReceipts" | "fixProposals" | "retests",
    { total: number; nextCursor: string | null }
  >
  scanId?: string | null
  plainLanguage?: PlainLanguage
}

const retestResultSchema = z
  .object({
    scan: z.object({ id: z.string(), status: z.string() }).passthrough(),
  })
  .passthrough()

const findingPatchResultSchema = z
  .object({
    id: z.string(),
    status: z.string(),
  })
  .passthrough()

const verificationReceiptSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    method: z.string(),
    reason: z.string(),
    scanId: z.string(),
    sourceRevision: z.string().nullable(),
    verifierVersion: z.string().nullable(),
    evidence: z.unknown(),
    createdAt: z.string().datetime().or(z.string()),
  })
  .passthrough()

const evidenceSchema = z
  .object({ id: z.string(), type: z.string(), redactionStatus: z.string() })
  .passthrough()

/**
 * Engine-declared claim-context projection — allowlisted server-side, every
 * field labeled as an engine assertion rather than app verification.
 */
const evidenceInsightsSchema = z
  .object({
    counterevidence: z.string().optional(),
    evidenceWarnings: z.array(z.string()).optional(),
    severityChangeConditions: z.string().optional(),
    assumptions: z.string().optional(),
    confidenceRationale: z.string().optional(),
    contextualCvssReasoning: z.string().optional(),
    advisoryCvss: z
      .object({
        score: z.number(),
        vector: z.string().optional(),
        source: z.string().optional(),
        metric_reasoning: z.string().optional(),
      })
      .optional(),
    engineVerificationState: z.string().optional(),
    engineConfidence: z.string().optional(),
  })
  .nullable()

const fixProposalSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    summary: z.string(),
    createdAt: z.string().optional(),
    pullRequests: z
      .array(
        z
          .object({
            id: z.string(),
            status: z.string(),
            prNumber: z.number().nullable(),
            prUrl: z.string().nullable(),
            branchName: z.string(),
            createdAt: z.string(),
            mergedAt: z.string().nullable(),
            closedAt: z.string().nullable(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough()

const retestSchema = z
  .object({
    id: z.string(),
    scanId: z.string(),
    status: z.string(),
    createdAt: z.string().datetime().or(z.string()),
  })
  .passthrough()

const historyItemSchemas = {
  evidence: evidenceSchema,
  verificationReceipts: verificationReceiptSchema,
  fixProposals: fixProposalSchema,
  retests: retestSchema,
} as const

const findingDetailSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    category: z.string().nullable().optional(),
    cwe: z.string().nullable().optional(),
    cvssScore: z.number().nullable().optional(),
    technicalDetail: z.string().nullable().optional(),
    recommendedFix: z.string().nullable().optional(),
    businessImpact: z.string().nullable().optional(),
    exploitability: z.string().nullable().optional(),
    verificationStatus: z.string().optional(),
    verificationMethod: z.string().nullable().optional(),
    verificationReason: z.string().nullable().optional(),
    statusReason: z.string().nullable().optional(),
    scanId: z.string().nullable().optional(),
    verificationReceipts: z.array(verificationReceiptSchema).optional(),
    evidence: z.array(evidenceSchema).optional(),
    evidenceInsights: evidenceInsightsSchema.optional(),
    fixProposals: z.array(fixProposalSchema).optional(),
    retests: z.array(retestSchema).optional(),
    historyPagination: z
      .record(
        z.enum(["evidence", "verificationReceipts", "fixProposals", "retests"]),
        z.object({ total: z.number(), nextCursor: z.string().nullable() })
      )
      .optional(),
    plainLanguage: z
      .object({
        title: z.string(),
        whatItIs: z.string(),
        whyItMatters: z.string(),
        howToFix: z.string(),
        difficulty: z.string(),
        estimatedTimeToFix: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

function findingHistoryPageSchema(collection: keyof typeof historyItemSchemas) {
  return z.object({
    items: z.array(historyItemSchemas[collection]),
    nextCursor: z.string().nullable(),
    total: z.number().int().nonnegative(),
  })
}

// ---------------------------------------------------------------------------
// FindingDetailDrawer
// ---------------------------------------------------------------------------

export function FindingStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_BADGE[status] ?? "muted"}>
      {FINDING_STATUS_LABELS[status] ?? humanizeToken(status)}
    </Badge>
  )
}

export function FindingDetailDrawer({
  canCreatePr,
  finding,
  workspaceId,
  targetId,
  observedInScanId,
  onClose,
  onStatusChange,
}: {
  canCreatePr: boolean
  finding: FindingListItem
  workspaceId: string
  targetId?: string
  observedInScanId?: string
  onClose: () => void
  onStatusChange: (id: string, status: string) => void
}) {
  const [detail, setDetail] = useState<FindingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [drawerError, setDrawerError] = useState<string | null>(null)
  const [showFixForm, setShowFixForm] = useState(false)
  const [fixSummary, setFixSummary] = useState("")
  const [creatingFix, setCreatingFix] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const [creatingRetest, setCreatingRetest] = useState(false)
  const [retestError, setRetestError] = useState<string | null>(null)
  const [queuedRetestScanId, setQueuedRetestScanId] = useState<string | null>(null)
  const historyLoadingRef = useRef(new Set<keyof typeof historyItemSchemas>())
  const [historyLoading, setHistoryLoading] = useState(
    () => new Set<keyof typeof historyItemSchemas>()
  )
  const [historyError, setHistoryError] = useState<string | null>(null)

  // Status transitions
  const [showAcceptRisk, setShowAcceptRisk] = useState(false)
  const [showFalsePositive, setShowFalsePositive] = useState(false)
  const [patchLoading, setPatchLoading] = useState(false)
  const [patchError, setPatchError] = useState<string | null>(null)

  // Audience mode for "What to do" tab
  const [audienceMode, setAudienceMode] = useState<AudienceMode>("developer")
  const [detailTab, setDetailTab] = useState("what-to-do")

  const knownExploited = detail?.technicalDetail?.includes("CISA KEV:") ?? false
  const epssSummary = extractEpssPercentage(detail?.technicalDetail)

  const detailParams = new URLSearchParams({ workspaceId })
  if (targetId) detailParams.set("targetId", targetId)
  if (observedInScanId) detailParams.set("observedInScanId", observedInScanId)
  const detailUrl = `/api/findings/${finding.id}?${detailParams.toString()}`

  const fetchDetail = useCallback(
    (signal?: AbortSignal) =>
      apiGet(detailUrl, {
        schema: findingDetailSchema,
        ...(signal ? { signal } : {}),
      }),
    [detailUrl]
  )

  useEffect(() => {
    // A different finding selection remounts this drawer (keyed by finding id),
    // and the unmount abort cancels the superseded request in flight.
    const controller = new AbortController()
    let cancelled = false
    fetchDetail(controller.signal)
      .then((res) => {
        if (cancelled) return
        setDetail(res ?? null)
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted) return
        setDetail(null)
        setDrawerError(err instanceof Error ? err.message : "Failed to load finding details.")
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [fetchDetail])

  const handleRetry = useCallback(() => {
    setLoading(true)
    setDrawerError(null)
    fetchDetail()
      .then((res) => setDetail(res ?? null))
      .catch((err) => {
        setDetail(null)
        setDrawerError(err instanceof Error ? err.message : "Failed to load finding details.")
      })
      .finally(() => setLoading(false))
  }, [fetchDetail])

  async function loadMoreHistory(
    collection: "evidence" | "verificationReceipts" | "fixProposals" | "retests"
  ) {
    if (historyLoadingRef.current.has(collection)) return
    const cursor = detail?.historyPagination?.[collection]?.nextCursor
    if (!cursor) return
    historyLoadingRef.current.add(collection)
    setHistoryLoading((current) => new Set(current).add(collection))
    setHistoryError(null)
    try {
      const params = new URLSearchParams({ workspaceId, collection, cursor })
      if (targetId) params.set("targetId", targetId)
      if (observedInScanId) params.set("observedInScanId", observedInScanId)
      const page = await apiGet(`/api/findings/${finding.id}/history?${params.toString()}`, {
        schema: findingHistoryPageSchema(collection),
      })
      setDetail((current) => {
        if (!current) return current
        const updated: FindingDetail = {
          ...current,
          [collection]: [...(current[collection] ?? []), ...page.items],
          historyPagination: {
            ...current.historyPagination!,
            [collection]: { total: page.total, nextCursor: page.nextCursor },
          },
        }
        return updated
      })
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not load more history.")
    } finally {
      historyLoadingRef.current.delete(collection)
      setHistoryLoading((current) => {
        const next = new Set(current)
        next.delete(collection)
        return next
      })
    }
  }

  async function saveFixProposal() {
    setCreatingFix(true)
    setFixError(null)
    try {
      await apiPost(`/api/findings/${finding.id}/fix-proposals`, {
        workspaceId,
        summary: fixSummary.trim(),
      })
      setShowFixForm(false)
      setFixSummary("")
      const res = await apiGet(detailUrl, {
        schema: findingDetailSchema,
      })
      setDetail(res ?? null)
    } catch (err) {
      setFixError(err instanceof Error ? err.message : "Failed to create fix proposal")
    } finally {
      setCreatingFix(false)
    }
  }

  async function queueRetest() {
    if (!detail?.scanId) return
    setCreatingRetest(true)
    setRetestError(null)
    try {
      const result = await apiPost(
        `/api/findings/${finding.id}/retests`,
        { workspaceId },
        { schema: retestResultSchema }
      )
      setQueuedRetestScanId(result.scan.id)
      const res = await apiGet(detailUrl, {
        schema: findingDetailSchema,
      })
      setDetail(res ?? null)
    } catch (err) {
      setRetestError(err instanceof Error ? err.message : "Failed to create retest")
    } finally {
      setCreatingRetest(false)
    }
  }

  async function handleAcceptRisk(comment: string) {
    setPatchLoading(true)
    setPatchError(null)
    try {
      const result = await apiPatch(
        `/api/findings/${finding.id}`,
        {
          workspaceId,
          action: "accept_risk",
          reason: comment,
        },
        { schema: findingPatchResultSchema }
      )
      onStatusChange(finding.id, result.status)
      setShowAcceptRisk(false)
      const res = await apiGet(detailUrl, {
        schema: findingDetailSchema,
      })
      setDetail(res ?? null)
    } catch (err) {
      setPatchError(err instanceof Error ? err.message : "Failed to update status")
    } finally {
      setPatchLoading(false)
    }
  }

  async function handleFalsePositive(comment: string) {
    setPatchLoading(true)
    setPatchError(null)
    try {
      const result = await apiPatch(
        `/api/findings/${finding.id}`,
        {
          workspaceId,
          action: "false_positive",
          reason: comment,
        },
        { schema: findingPatchResultSchema }
      )
      onStatusChange(finding.id, result.status)
      setShowFalsePositive(false)
      const res = await apiGet(detailUrl, {
        schema: findingDetailSchema,
      })
      setDetail(res ?? null)
    } catch (err) {
      setPatchError(err instanceof Error ? err.message : "Failed to update status")
    } finally {
      setPatchLoading(false)
    }
  }

  const SevIcon = SEVERITY_ICON[finding.severity] ?? Shield

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full max-w-lg overflow-y-auto p-4 sm:max-w-lg sm:p-6">
        <SheetHeader className="mb-4 p-0 pr-8 text-left">
          {/* Breadcrumb inside drawer */}
          <nav aria-label="Breadcrumb" className="mb-1">
            <ol className="text-muted-foreground flex items-center gap-1 text-xs">
              <li>
                <Link
                  href={findingsHref({
                    tab: "issues",
                    ...(observedInScanId ? { scanId: observedInScanId } : {}),
                    ...(targetId ? { target: targetId } : {}),
                  })}
                  className="hover:text-foreground"
                >
                  Findings
                </Link>
              </li>
              <li aria-hidden="true">
                <ChevronRight className="h-3 w-3" />
              </li>
              <li className="text-foreground max-w-50 truncate font-medium" title={finding.title}>
                {finding.title}
              </li>
            </ol>
          </nav>
          <SheetTitle>{finding.title}</SheetTitle>
          <SheetDescription className="sr-only">
            Finding evidence, verification state, remediation and retest actions
          </SheetDescription>
        </SheetHeader>

        {loading ? (
          // Stable skeleton matching the final layout: badges, tabs, and the
          // content blocks the drawer will occupy — no spinner-only state.
          <div className="space-y-4" aria-busy="true" aria-label="Loading finding details">
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-9 w-full" />
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </div>
          </div>
        ) : drawerError ? (
          <div
            className="bg-destructive/5 border-destructive/20 rounded-lg border p-4"
            role="alert"
          >
            <div className="text-destructive flex items-center gap-2 text-sm font-medium">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {drawerError}
            </div>
            <div className="mt-3 flex gap-2">
              <Button type="button" size="sm" onClick={() => void handleRetry()}>
                Retry
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : detail ? (
          <div className="space-y-4">
            {/* Badges row */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Severity with icon — WCAG 1.4.1 */}
              <Badge variant={SEVERITY_BADGE[finding.severity] ?? "muted"}>
                <SevIcon
                  className={cn("mr-1 h-3 w-3", SEVERITY_COLOR[finding.severity])}
                  aria-hidden="true"
                />
                {severityLabel(finding.severity)}
              </Badge>
              <FindingStatusBadge status={finding.status} />
              {finding.verified ? (
                <Badge variant="success">
                  <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />
                  Verified
                </Badge>
              ) : (
                <Badge variant="muted">
                  {getVerificationStatusLabel(finding.verificationStatus)}
                </Badge>
              )}
              {finding.confidence && (
                <Badge variant="muted">{finding.confidence} evidence strength (heuristic)</Badge>
              )}
            </div>

            {/* "View scan" cross-link when scanId is available */}
            {detail.scanId && (
              <Link
                href={`/dashboard/scans/${encodeURIComponent(detail.scanId)}`}
                className="text-primary inline-flex items-center gap-1 text-xs font-medium hover:underline"
              >
                <Shield className="h-3 w-3" aria-hidden="true" />
                View scan
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            )}

            {/* ----------------------------------------------------------------
                TABBED LAYOUT
                Tab 1: What to do  (plain language + audience mode + next step)
                Tab 2: Technical   (technical details, CWE, CVSS, EPSS, evidence)
                Tab 3: History     (retests, fix proposals, verification receipts)
            ----------------------------------------------------------------- */}
            <Tabs value={detailTab} onValueChange={setDetailTab} className="w-full">
              <TabsList className="h-auto min-h-9 w-full">
                <TabsTrigger
                  value="what-to-do"
                  className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-1 leading-tight"
                >
                  What to do
                </TabsTrigger>
                <TabsTrigger
                  value="technical"
                  className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-1 leading-tight"
                >
                  Technical
                </TabsTrigger>
                <TabsTrigger
                  value="history"
                  className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-1 leading-tight"
                >
                  History
                </TabsTrigger>
              </TabsList>

              {/* ============================================================
                  TAB 1: What to do
              ============================================================ */}
              <FindingActionTab
                detail={detail}
                finding={finding}
                targetId={targetId}
                audienceMode={audienceMode}
                setAudienceMode={setAudienceMode}
                showFixForm={showFixForm}
                setShowFixForm={setShowFixForm}
                fixSummary={fixSummary}
                setFixSummary={setFixSummary}
                creatingFix={creatingFix}
                fixError={fixError}
                setFixError={setFixError}
                saveFixProposal={saveFixProposal}
                creatingRetest={creatingRetest}
                retestError={retestError}
                queuedRetestScanId={queuedRetestScanId}
                queueRetest={queueRetest}
                setDetailTab={setDetailTab}
                showAcceptRisk={showAcceptRisk}
                setShowAcceptRisk={setShowAcceptRisk}
                showFalsePositive={showFalsePositive}
                setShowFalsePositive={setShowFalsePositive}
                patchLoading={patchLoading}
                patchError={patchError}
                setPatchError={setPatchError}
                handleAcceptRisk={handleAcceptRisk}
                handleFalsePositive={handleFalsePositive}
              />

              {/* ============================================================
                  TAB 2: Technical
              ============================================================ */}
              <FindingTechnicalTab
                detail={detail}
                knownExploited={knownExploited}
                epssSummary={epssSummary}
                historyLoading={historyLoading}
                loadMoreHistory={loadMoreHistory}
              />

              {/* ============================================================
                  TAB 3: History
              ============================================================ */}
              <FindingHistoryTab
                detail={detail}
                finding={finding}
                canCreatePr={canCreatePr}
                workspaceId={workspaceId}
                historyLoading={historyLoading}
                loadMoreHistory={loadMoreHistory}
                historyError={historyError}
              />
            </Tabs>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Failed to load finding details.</p>
        )}
      </SheetContent>
    </Sheet>
  )
}
