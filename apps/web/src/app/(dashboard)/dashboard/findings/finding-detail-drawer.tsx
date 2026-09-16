"use client"
import { CreateFixPrAction } from "@/components/create-fix-pr-action"
import { useState, useEffect, useCallback, useRef, useId } from "react"
import { z } from "zod"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import Link from "next/link"
import { Shield, ChevronRight, CheckCircle2, AlertCircle, Wrench, ArrowRight } from "lucide-react"
import { Button, Badge, Textarea, FormField, Spinner, buttonVariants, cn } from "@lyrashield/ui"
import { apiGet, apiPost, apiPatch } from "@/lib/api-client"
import { formatDate } from "@/lib/date-format"
import { getFindingNextAction } from "@/lib/finding-next-step"
import { SEVERITY_BADGE } from "@/lib/severity-badge"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { severityLabel, humanizeToken } from "@/lib/labels"
import { FINDING_STATUS_LABELS, getVerificationStatusLabel } from "@/lib/enum-labels"
import {
  buildRemediationTimeline,
  type RemediationTimelineEvent,
  type TimelineRetestInput,
} from "@/lib/finding-remediation-timeline"
import {
  STATUS_BADGE,
  SEVERITY_ICON,
  SEVERITY_COLOR,
  extractEpssPercentage,
} from "./finding-presentation"
import type { FindingListItem } from "./findings-client"

// ---------------------------------------------------------------------------
// Audience mode — client-side reframing
// ---------------------------------------------------------------------------

type AudienceMode = "founder" | "developer" | "security-engineer" | "enterprise-admin" | "auditor"

const AUDIENCE_LABELS: Record<AudienceMode, string> = {
  founder: "Founder / CEO",
  developer: "Developer",
  "security-engineer": "Security Engineer",
  "enterprise-admin": "Enterprise Admin",
  auditor: "Auditor",
}

/**
 * Returns a short mode-specific lead-in paragraph to prepend to the
 * plain-language content. The underlying facts are identical — only the
 * framing emphasis changes. This is a purely client-side reframe.
 *
 * SEAM: When the API gains per-mode server content, replace this function
 * with a fetch to /api/findings/[id]/explain?mode=[mode] and remove the
 * client-side construction below.
 */
function getAudienceLeadIn(mode: AudienceMode, severity: string, title: string): string {
  switch (mode) {
    case "founder":
      return `As a business leader, this ${severity.toLowerCase()} finding ("${title}") represents a risk to your product, customers, or compliance posture. Your engineering team can resolve it — the key action is prioritising and tracking it.`
    case "developer":
      return `This is a ${severity.toLowerCase()} finding in your codebase. The steps below give you a direct path to fix it. Focus on the "How to fix" section for implementation guidance.`
    case "security-engineer":
      return `${severity} severity finding. Review CWE, CVSS, and EPSS data in the Technical tab for triage. The fix guidance below is a starting point — validate against your threat model.`
    case "enterprise-admin":
      return `This ${severity.toLowerCase()} finding may affect compliance, SLAs, or vendor risk assessments. Ensure it is assigned to an owner and that resolution is tracked against your remediation SLA.`
    case "auditor":
      return `For audit purposes, this ${severity.toLowerCase()} finding ("${title}") should be referenced in your risk register. Verification receipts and retest history are available in the History tab.`
  }
}

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

interface FindingDetail {
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

// Strict client-side guard for the retest receipt evidence persisted by the
// worker. Unknown or historical evidence shapes stay renderable as the generic
// receipt below and are never trusted as this shape.
const retestReceiptEvidenceSchema = z
  .object({
    retestId: z.string(),
    scannerSource: z.string(),
    baseline: z
      .object({
        scanId: z.string(),
        manifestChecksum: z.string(),
        sourceRevision: z.string().nullable(),
        targetUrlChecksum: z.string().nullable(),
      })
      .nullable(),
    retest: z
      .object({
        scanId: z.string(),
        manifestChecksum: z.string(),
        sourceRevision: z.string().nullable(),
        targetUrlChecksum: z.string().nullable(),
      })
      .nullable(),
    coverageReceiptIds: z.array(z.string()),
  })
  .passthrough()

function parseRetestReceipt(evidence: unknown) {
  const parsed = retestReceiptEvidenceSchema.safeParse(evidence)
  return parsed.success ? parsed.data : null
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
// StatusActionConfirm — inline confirm with required comment
// ---------------------------------------------------------------------------

/**
 * Inline confirm panel for status-transition actions (accept risk / false positive).
 * The comment field is required client-side for intentionality and is persisted
 * as the finding's statusReason via the /api/findings/[id] PATCH body.
 */
function StatusActionConfirm({
  label,
  confirmLabel,
  onConfirm,
  onCancel,
  isLoading,
  error,
}: {
  label: string
  confirmLabel: string
  onConfirm: (comment: string) => void | Promise<void>
  onCancel: () => void
  isLoading: boolean
  error: string | null
}) {
  const [comment, setComment] = useState("")
  const trimmed = comment.trim()
  // useId: two confirm panels can technically be mounted at once (the
  // drawer's action states are not structurally exclusive), and a duplicated
  // static id breaks label association for screen readers.
  const commentFieldId = useId()

  return (
    <div
      className="bg-muted/40 mt-2 space-y-2 rounded-lg border p-3"
      role="group"
      aria-label={label}
    >
      <FormField label={label} htmlFor={commentFieldId}>
        <Textarea
          id={commentFieldId}
          rows={2}
          placeholder="Add a comment explaining your decision (required)…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          aria-required="true"
          className="w-full"
          autoFocus
        />
      </FormField>
      {error && <p className="text-destructive text-xs">{error}</p>}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={isLoading || trimmed.length === 0}
          onClick={() => void onConfirm(trimmed)}
        >
          {isLoading ? <Spinner /> : confirmLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={isLoading}>
          Cancel
        </Button>
      </div>
    </div>
  )
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
  onClose,
  onStatusChange,
}: {
  canCreatePr: boolean
  finding: FindingListItem
  workspaceId: string
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

  const fetchDetail = useCallback(
    (signal?: AbortSignal) =>
      apiGet(`/api/findings/${finding.id}?workspaceId=${workspaceId}`, {
        schema: findingDetailSchema,
        ...(signal ? { signal } : {}),
      }),
    [finding.id, workspaceId]
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
      const page = await apiGet(`/api/findings/${finding.id}/history?${params.toString()}`, {
        schema: findingHistoryPageSchema(collection),
      })
      setDetail((current) => {
        if (!current) return current
        return {
          ...current,
          [collection]: [...(current[collection] ?? []), ...page.items],
          historyPagination: {
            ...current.historyPagination!,
            [collection]: { total: page.total, nextCursor: page.nextCursor },
          },
        } as FindingDetail
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

  const latestRetest = detail?.retests?.[0] ?? null
  const hasFixProposal = (detail?.fixProposals?.length ?? 0) > 0
  const nextAction = getFindingNextAction({
    status: finding.status,
    latestRetestStatus: latestRetest?.status,
    hasEvidence: (detail?.evidence?.length ?? 0) > 0,
    hasFixProposal,
  })
  const nextStep = nextAction.action

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
      const res = await apiGet(`/api/findings/${finding.id}?workspaceId=${workspaceId}`, {
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
      const res = await apiGet(`/api/findings/${finding.id}?workspaceId=${workspaceId}`, {
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
      const res = await apiGet(`/api/findings/${finding.id}?workspaceId=${workspaceId}`, {
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
  const isResolved = finding.status === "ACCEPTED_RISK" || finding.status === "FALSE_POSITIVE"

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full max-w-lg overflow-y-auto p-6 sm:max-w-lg">
        <SheetHeader className="mb-4 p-0 pr-8 text-left">
          {/* Breadcrumb inside drawer */}
          <nav aria-label="Breadcrumb" className="mb-1">
            <ol className="text-muted-foreground flex items-center gap-1 text-xs">
              <li>
                <Link href="/dashboard/findings" className="hover:text-foreground">
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
            Finding evidence, verification state, remediation, and retest actions
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
              <TabsList className="w-full">
                <TabsTrigger value="what-to-do" className="flex-1">
                  What to do
                </TabsTrigger>
                <TabsTrigger value="technical" className="flex-1">
                  Technical
                </TabsTrigger>
                <TabsTrigger value="history" className="flex-1">
                  History
                </TabsTrigger>
              </TabsList>

              {/* ============================================================
                  TAB 1: What to do
              ============================================================ */}
              <TabsContent value="what-to-do" className="mt-4 space-y-4">
                {/* Audience mode selector */}
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="audience-mode"
                    className="text-muted-foreground shrink-0 text-xs font-medium"
                  >
                    Audience:
                  </label>
                  <select
                    id="audience-mode"
                    value={audienceMode}
                    onChange={(e) => setAudienceMode(e.target.value as AudienceMode)}
                    className="bg-background focus:ring-ring rounded-md border px-2 py-1 text-xs focus:ring-2 focus:outline-none"
                    aria-label="Select audience mode for plain-language explanation"
                  >
                    {(Object.entries(AUDIENCE_LABELS) as [AudienceMode, string][]).map(
                      ([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      )
                    )}
                  </select>
                </div>

                {/* Next-step action panel */}
                <div className="border-primary/30 bg-primary/5 rounded-lg border p-4">
                  <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                    Next step
                  </p>
                  {nextStep === "NONE" ? (
                    <p className="text-muted-foreground mt-2 text-sm">{nextAction.reason}</p>
                  ) : nextStep === "REPORT" && latestRetest ? (
                    <div className="mt-2">
                      <h3 className="font-semibold">
                        Turn the retest result into an assurance report
                      </h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        This fresh retest passed. Generate an immutable report from its retained
                        result.
                      </p>
                      <Link
                        href={`/dashboard/findings?tab=reports&scanId=${encodeURIComponent(latestRetest.scanId)}`}
                        className={buttonVariants({ size: "sm", className: "mt-3" })}
                      >
                        Generate report
                        <ArrowRight className="size-4" aria-hidden="true" />
                      </Link>
                    </div>
                  ) : nextStep === "RETEST_IN_PROGRESS" && latestRetest ? (
                    <div className="mt-2">
                      <h3 className="font-semibold">Retest in progress</h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        The fresh scan will determine whether the recorded change is
                        retest-confirmed or remains inconclusive.
                      </p>
                      <Link
                        href={`/dashboard/scans/${encodeURIComponent(latestRetest.scanId)}`}
                        className={buttonVariants({
                          variant: "secondary",
                          size: "sm",
                          className: "mt-3",
                        })}
                      >
                        View retest
                        <ArrowRight className="size-4" aria-hidden="true" />
                      </Link>
                    </div>
                  ) : showFixForm ? (
                    <div className="mt-3 space-y-3">
                      <div>
                        <h3 className="font-semibold">Create a fix proposal</h3>
                        <p className="text-muted-foreground mt-1 text-sm">
                          Review and edit this plan before saving it. Creating a proposal does not
                          change your code.
                        </p>
                      </div>
                      <FormField label="Fix summary" htmlFor="fix-summary">
                        <Textarea
                          id="fix-summary"
                          className="w-full"
                          rows={4}
                          placeholder="Describe the change you intend to make..."
                          value={fixSummary}
                          onChange={(e) => setFixSummary(e.target.value)}
                        />
                      </FormField>
                      {fixError && <p className="text-destructive text-xs">{fixError}</p>}
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={creatingFix || fixSummary.trim().length < 10}
                          onClick={async () => {
                            setCreatingFix(true)
                            setFixError(null)
                            try {
                              await apiPost(`/api/findings/${finding.id}/fix-proposals`, {
                                workspaceId,
                                summary: fixSummary.trim(),
                              })
                              setShowFixForm(false)
                              setFixSummary("")
                              const res = await apiGet(
                                `/api/findings/${finding.id}?workspaceId=${workspaceId}`,
                                { schema: findingDetailSchema }
                              )
                              setDetail(res ?? null)
                            } catch (err) {
                              setFixError(
                                err instanceof Error ? err.message : "Failed to create fix proposal"
                              )
                            } finally {
                              setCreatingFix(false)
                            }
                          }}
                        >
                          {creatingFix ? <Spinner /> : "Save proposal"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setShowFixForm(false)
                            setFixSummary("")
                            setFixError(null)
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : nextStep === "INSPECT_EVIDENCE" ? (
                    <div className="mt-2">
                      <h3 className="font-semibold">Review the retained evidence</h3>
                      <p className="text-muted-foreground mt-1 text-sm">{nextAction.reason}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button type="button" size="sm" onClick={() => setDetailTab("technical")}>
                          View evidence
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setShowFixForm(true)}
                        >
                          Create fix proposal
                        </Button>
                      </div>
                    </div>
                  ) : nextStep === "RETEST" ? (
                    <div className="mt-2">
                      <h3 className="font-semibold">Apply the change, then run a fresh retest</h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        The proposal is recorded, but LyraShield has not changed your code. Queue
                        the retest only after you apply the fix.
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {!detail.scanId ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-block">
                                <Button type="button" size="sm" disabled>
                                  Queue fresh retest
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              A fresh retest needs a linked server scan. Run a scan for this target
                              first, or check that this finding came from a completed scan rather
                              than an imported report.
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            disabled={creatingRetest}
                            onClick={() => void queueRetest()}
                          >
                            {creatingRetest ? (
                              <span className="flex items-center gap-2">
                                <Spinner /> Queuing retest...
                              </span>
                            ) : (
                              "Queue fresh retest"
                            )}
                          </Button>
                        )}
                      </div>
                      {retestError && (
                        <p className="text-destructive mt-2 text-xs">{retestError}</p>
                      )}
                    </div>
                  ) : (
                    <div className="mt-2">
                      <h3 className="font-semibold">Review the guidance and record your plan</h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        Use the evidence and recommended fix below, then save the change you intend
                        to make.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        className="mt-3"
                        onClick={() => {
                          setFixSummary(
                            detail.recommendedFix ?? detail.plainLanguage?.howToFix ?? ""
                          )
                          setFixError(null)
                          setShowFixForm(true)
                        }}
                      >
                        <Wrench className="mr-1 size-4" aria-hidden="true" />
                        Create fix proposal
                      </Button>
                    </div>
                  )}
                  {queuedRetestScanId && nextStep !== "RETEST_IN_PROGRESS" && (
                    <Link
                      href={`/dashboard/scans/${encodeURIComponent(queuedRetestScanId)}`}
                      className="text-primary mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-medium hover:underline"
                    >
                      View queued retest
                      <ArrowRight className="size-4" aria-hidden="true" />
                    </Link>
                  )}
                </div>

                {/* Summary */}
                <div>
                  <h3 className="mb-1 text-sm font-medium">Summary</h3>
                  <p className="text-muted-foreground text-sm">{detail.summary}</p>
                </div>

                {/* Plain-language explanation with audience mode lead-in */}
                {detail.plainLanguage && (
                  <div className="bg-muted/30 rounded-lg border p-4">
                    <p className="text-sm font-semibold">Plain-Language Explanation</p>
                    {/* Audience-mode lead-in — client-side reframe of same facts.
                        SEAM: replace with per-mode server content when API supports it. */}
                    <p className="text-muted-foreground border-primary/30 mt-2 border-l-2 pl-2 text-xs italic">
                      {getAudienceLeadIn(audienceMode, finding.severity, finding.title)}
                    </p>
                    <div className="mt-3 space-y-3">
                      <div>
                        <p className="text-muted-foreground mb-0.5 text-xs font-medium">
                          What it is
                        </p>
                        <p className="text-sm">{detail.plainLanguage.whatItIs}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-0.5 text-xs font-medium">
                          Why it matters
                        </p>
                        <p className="text-sm">{detail.plainLanguage.whyItMatters}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-0.5 text-xs font-medium">
                          How to fix
                        </p>
                        <p className="text-sm">{detail.plainLanguage.howToFix}</p>
                      </div>
                      <div className="text-muted-foreground flex items-center gap-3 pt-1 text-xs">
                        <span>
                          Difficulty:{" "}
                          <span className="font-medium">{detail.plainLanguage.difficulty}</span>
                        </span>
                        <span>
                          Est. time:{" "}
                          <span className="font-medium">
                            {detail.plainLanguage.estimatedTimeToFix}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Status transition actions — Accept risk / Mark false positive */}
                {!isResolved && (
                  <details className="space-y-2 border-t pt-2">
                    <summary className="cursor-pointer text-sm font-medium">
                      Other actions: risk decisions
                    </summary>
                    <div className="flex flex-wrap gap-2">
                      {!showAcceptRisk && !showFalsePositive && (
                        <>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setShowAcceptRisk(true)
                              setShowFalsePositive(false)
                              setPatchError(null)
                            }}
                          >
                            Accept risk
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setShowFalsePositive(true)
                              setShowAcceptRisk(false)
                              setPatchError(null)
                            }}
                          >
                            Mark false positive
                          </Button>
                        </>
                      )}
                    </div>
                    {showAcceptRisk && (
                      <StatusActionConfirm
                        label="Accept risk — this finding will be acknowledged but not fixed."
                        confirmLabel="Accept risk"
                        onConfirm={handleAcceptRisk}
                        onCancel={() => {
                          setShowAcceptRisk(false)
                          setPatchError(null)
                        }}
                        isLoading={patchLoading}
                        error={patchError}
                      />
                    )}
                    {showFalsePositive && (
                      <StatusActionConfirm
                        label="Mark as false positive — this finding will be dismissed."
                        confirmLabel="Mark false positive"
                        onConfirm={handleFalsePositive}
                        onCancel={() => {
                          setShowFalsePositive(false)
                          setPatchError(null)
                        }}
                        isLoading={patchLoading}
                        error={patchError}
                      />
                    )}
                  </details>
                )}
                {isResolved && (
                  <div className="bg-muted/30 text-muted-foreground rounded-md border px-3 py-2 text-xs">
                    This finding is marked as{" "}
                    <span className="font-medium">
                      {FINDING_STATUS_LABELS[finding.status] ?? humanizeToken(finding.status)}
                    </span>
                    .
                  </div>
                )}
              </TabsContent>

              {/* ============================================================
                  TAB 2: Technical
              ============================================================ */}
              <TabsContent value="technical" className="mt-4 space-y-4">
                {/* Metadata badges */}
                {(detail.cwe ||
                  detail.cvssScore != null ||
                  detail.category ||
                  knownExploited ||
                  epssSummary) && (
                  <div className="flex flex-wrap gap-2 text-xs">
                    {knownExploited && <Badge variant="danger">Known exploited · CISA KEV</Badge>}
                    {epssSummary && <Badge variant="warning">EPSS {epssSummary}</Badge>}
                    {detail.cwe && <Badge variant="info">{detail.cwe}</Badge>}
                    {detail.cvssScore != null && (
                      <Badge variant="warning">CVSS {detail.cvssScore}</Badge>
                    )}
                    {detail.category && <Badge variant="muted">{detail.category}</Badge>}
                  </div>
                )}

                {detail.exploitability && (
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Exploitability</h3>
                    <p className="text-muted-foreground text-sm">{detail.exploitability}</p>
                  </div>
                )}

                {detail.recommendedFix && (
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Recommended Fix</h3>
                    <p className="text-muted-foreground text-sm">{detail.recommendedFix}</p>
                  </div>
                )}

                {detail.businessImpact && (
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Business Impact</h3>
                    <p className="text-muted-foreground text-sm">{detail.businessImpact}</p>
                  </div>
                )}

                {detail.technicalDetail && (
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Technical Details</h3>
                    <pre
                      className="bg-muted mt-1 overflow-x-auto rounded-lg p-3 text-xs whitespace-pre-wrap"
                      tabIndex={0}
                      aria-label="Technical details"
                    >
                      {detail.technicalDetail}
                    </pre>
                  </div>
                )}

                {detail.evidence && detail.evidence.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">
                      Evidence ({detail.historyPagination?.evidence.total ?? detail.evidence.length}
                      )
                    </h3>
                    <div className="space-y-2">
                      {detail.evidence.map((ev) => (
                        <div
                          key={ev.id}
                          className="flex items-center justify-between gap-2 rounded-lg border p-2 text-sm"
                        >
                          <div className="flex items-center gap-2">
                            <Badge variant="muted">{ev.type}</Badge>
                          </div>
                          <Badge
                            variant={ev.redactionStatus === "complete" ? "success" : "warning"}
                          >
                            {ev.redactionStatus}
                          </Badge>
                        </div>
                      ))}
                    </div>
                    {detail.historyPagination?.evidence.nextCursor && (
                      <Button
                        className="mt-2"
                        variant="outline"
                        size="sm"
                        disabled={historyLoading.has("evidence")}
                        onClick={() => void loadMoreHistory("evidence")}
                      >
                        {historyLoading.has("evidence") ? <Spinner /> : null}
                        Load more evidence
                      </Button>
                    )}
                  </div>
                )}

                {detail.verificationReason && (
                  <div className="bg-muted/30 rounded-lg border p-3">
                    <h3 className="text-sm font-medium">Verification state</h3>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {detail.verificationReason}
                    </p>
                  </div>
                )}

                {detail.statusReason && (
                  <div className="bg-muted/30 rounded-lg border p-3">
                    <h3 className="text-sm font-medium">Status reason</h3>
                    <p className="text-muted-foreground mt-1 text-sm">{detail.statusReason}</p>
                  </div>
                )}

                {!detail.technicalDetail &&
                  !detail.exploitability &&
                  !detail.cwe &&
                  !detail.cvssScore &&
                  !detail.category &&
                  !detail.evidence?.length && (
                    <p className="text-muted-foreground text-sm">
                      No technical details are available for this finding.
                    </p>
                  )}
              </TabsContent>

              {/* ============================================================
                  TAB 3: History
              ============================================================ */}
              <TabsContent value="history" className="mt-4 space-y-4">
                <RemediationTimelineSection
                  finding={finding}
                  fixProposals={detail.fixProposals ?? []}
                  retests={detail.retests ?? []}
                />

                {detail.retests && detail.retests.length > 0 ? (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">
                      Retests ({detail.historyPagination?.retests.total ?? detail.retests.length})
                    </h3>
                    <div className="space-y-2">
                      {detail.retests.map((rt) => (
                        <div key={rt.id} className="flex items-center gap-2 text-sm">
                          <Badge
                            variant={
                              rt.status === "passed"
                                ? "success"
                                : rt.status === "failed"
                                  ? "danger"
                                  : "info"
                            }
                          >
                            {rt.status}
                          </Badge>
                          <Link
                            href={`/dashboard/scans/${encodeURIComponent(rt.scanId)}`}
                            className="text-primary text-xs hover:underline"
                          >
                            View scan
                          </Link>
                          <span className="text-muted-foreground text-xs">
                            {formatDate(rt.createdAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                    {detail.historyPagination?.retests.nextCursor && (
                      <Button
                        className="mt-2"
                        variant="outline"
                        size="sm"
                        disabled={historyLoading.has("retests")}
                        onClick={() => void loadMoreHistory("retests")}
                      >
                        {historyLoading.has("retests") ? <Spinner /> : null}
                        Load more retests
                      </Button>
                    )}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">No retests recorded yet.</p>
                )}

                {detail.fixProposals && detail.fixProposals.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">
                      Fix Proposals (
                      {detail.historyPagination?.fixProposals.total ?? detail.fixProposals.length})
                    </h3>
                    <div className="space-y-2">
                      {detail.fixProposals.map((fp) => (
                        <div key={fp.id} className="space-y-2 text-sm">
                          <Badge variant="info">{humanizeToken(fp.status)}</Badge>
                          <span className="text-muted-foreground">{fp.summary}</span>
                          {canCreatePr &&
                            (fp.status === "ready" ||
                              (finding.status === "FIX_READY" &&
                                ["draft", "approved"].includes(fp.status))) && (
                              <CreateFixPrAction workspaceId={workspaceId} proposalId={fp.id} />
                            )}
                        </div>
                      ))}
                    </div>
                    {detail.historyPagination?.fixProposals.nextCursor && (
                      <Button
                        className="mt-2"
                        variant="outline"
                        size="sm"
                        disabled={historyLoading.has("fixProposals")}
                        onClick={() => void loadMoreHistory("fixProposals")}
                      >
                        {historyLoading.has("fixProposals") ? <Spinner /> : null}
                        Load more proposals
                      </Button>
                    )}
                  </div>
                )}

                {detail.verificationReceipts && detail.verificationReceipts.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">
                      Verification Receipts (
                      {detail.historyPagination?.verificationReceipts.total ??
                        detail.verificationReceipts.length}
                      )
                    </h3>
                    <div className="space-y-2">
                      {detail.verificationReceipts.map((receipt) => {
                        const retestEvidence = parseRetestReceipt(receipt.evidence)
                        const validated = receipt.status === "VALIDATED"
                        return (
                          <div key={receipt.id} className="rounded-lg border p-3 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={validated ? "success" : "muted"}>
                                {getVerificationStatusLabel(receipt.status)}
                              </Badge>
                              <Badge variant="muted">{humanizeToken(receipt.method)}</Badge>
                              <span className="text-muted-foreground text-xs">
                                {formatDate(receipt.createdAt)}
                              </span>
                            </div>
                            <p className="text-muted-foreground mt-1 text-xs">{receipt.reason}</p>
                            {retestEvidence && (
                              <div className="text-muted-foreground mt-2 space-y-1 border-t pt-2 text-xs">
                                <p>
                                  Scanner source:{" "}
                                  <span className="font-mono">{retestEvidence.scannerSource}</span>
                                </p>
                                <p>
                                  Coverage:{" "}
                                  <span className={validated ? "text-emerald-500" : ""}>
                                    {validated ? "complete" : "insufficient"}
                                  </span>
                                </p>
                                {retestEvidence.baseline && (
                                  <p>
                                    Baseline scan:{" "}
                                    <Link
                                      href={`/dashboard/scans/${encodeURIComponent(retestEvidence.baseline.scanId)}`}
                                      className="text-primary hover:underline"
                                    >
                                      {retestEvidence.baseline.scanId}
                                    </Link>{" "}
                                    · manifest{" "}
                                    <span className="break-all font-mono">
                                      {retestEvidence.baseline.manifestChecksum}
                                    </span>
                                  </p>
                                )}
                                {retestEvidence.retest && (
                                  <p>
                                    Retest scan:{" "}
                                    <Link
                                      href={`/dashboard/scans/${encodeURIComponent(retestEvidence.retest.scanId)}`}
                                      className="text-primary hover:underline"
                                    >
                                      {retestEvidence.retest.scanId}
                                    </Link>{" "}
                                    · manifest{" "}
                                    <span className="break-all font-mono">
                                      {retestEvidence.retest.manifestChecksum}
                                    </span>
                                  </p>
                                )}
                                {retestEvidence.baseline?.sourceRevision ||
                                retestEvidence.retest?.sourceRevision ? (
                                  <p>
                                    Repository revisions: baseline{" "}
                                    <span className="break-all font-mono">
                                      {retestEvidence.baseline?.sourceRevision ?? "unavailable"}
                                    </span>{" "}
                                    · retest{" "}
                                    <span className="break-all font-mono">
                                      {retestEvidence.retest?.sourceRevision ?? "unavailable"}
                                    </span>
                                  </p>
                                ) : null}
                                {retestEvidence.baseline?.targetUrlChecksum ||
                                retestEvidence.retest?.targetUrlChecksum ? (
                                  <p>
                                    URL checksum: baseline{" "}
                                    <span className="break-all font-mono">
                                      {retestEvidence.baseline?.targetUrlChecksum ?? "unavailable"}
                                    </span>{" "}
                                    · retest{" "}
                                    <span className="break-all font-mono">
                                      {retestEvidence.retest?.targetUrlChecksum ?? "unavailable"}
                                    </span>
                                  </p>
                                ) : null}
                                {retestEvidence.coverageReceiptIds.length > 0 && (
                                  <p>
                                    Coverage receipts:{" "}
                                    <span className="break-all font-mono">
                                      {retestEvidence.coverageReceiptIds.join(", ")}
                                    </span>
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    {detail.historyPagination?.verificationReceipts.nextCursor && (
                      <Button
                        className="mt-2"
                        variant="outline"
                        size="sm"
                        disabled={historyLoading.has("verificationReceipts")}
                        onClick={() => void loadMoreHistory("verificationReceipts")}
                      >
                        {historyLoading.has("verificationReceipts") ? <Spinner /> : null}
                        Load more receipts
                      </Button>
                    )}
                  </div>
                )}

                {!detail.retests?.length &&
                  !detail.fixProposals?.length &&
                  !detail.verificationReceipts?.length && (
                    <p className="text-muted-foreground text-sm">
                      No history available for this finding yet.
                    </p>
                  )}
                {historyError && (
                  <p className="text-destructive text-sm" role="alert">
                    {historyError}
                  </p>
                )}
              </TabsContent>
            </Tabs>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Failed to load finding details.</p>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// W3-03: one remediation timeline assembled from stored receipts
// ---------------------------------------------------------------------------

const TIMELINE_TONE_CLASS: Record<RemediationTimelineEvent["tone"], string> = {
  neutral: "bg-muted text-foreground",
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
}

function RemediationTimelineSection({
  finding,
  fixProposals,
  retests,
}: {
  finding: FindingListItem
  fixProposals: Array<{
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
  retests: TimelineRetestInput[]
}) {
  const events = buildRemediationTimeline(
    {
      status: finding.status,
      verified: finding.verified,
      verificationStatus: finding.verificationStatus,
      verificationMethod: finding.verificationMethod ?? null,
      dispositionReason: finding.verificationReason ?? null,
      lastSeenAt: finding.lastSeenAt,
    },
    fixProposals.map((proposal) => ({
      id: proposal.id,
      status: proposal.status,
      summary: proposal.summary,
      createdAt: proposal.createdAt ?? finding.firstSeenAt,
      pullRequests: proposal.pullRequests ?? [],
    })),
    retests
  )

  if (events.length === 0) {
    return (
      <div className="bg-muted/30 rounded-lg border p-3">
        <h3 className="text-sm font-medium">Remediation timeline</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          No remediation receipts recorded yet. Timeline entries appear as fixes are proposed,
          opened as PRs, merged, retested, and verified.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-muted/30 rounded-lg border p-3">
      <h3 className="text-sm font-medium">Remediation timeline</h3>
      <ol className="mt-2 space-y-2">
        {events.map((event, index) => (
          <li key={`${event.kind}-${event.at}-${index}`} className="flex items-start gap-2 text-sm">
            <span
              className={`mt-0.5 rounded px-1.5 py-0.5 text-xs font-medium ${TIMELINE_TONE_CLASS[event.tone]}`}
            >
              {event.label}
            </span>
            <span className="text-muted-foreground min-w-0 flex-1">
              {event.detail ? `${event.detail} · ` : ""}
              {formatDate(event.at)}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-muted-foreground mt-2 text-xs">
        Built only from stored receipts. A proposed fix is not an applied fix, and a merged PR is
        not verification.
      </p>
    </div>
  )
}
