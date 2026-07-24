"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import {
  Bug,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Shield,
  ChevronRight,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Wrench,
  ArrowRight,
  Calendar,
  SortDesc,
} from "lucide-react"
import {
  Button,
  Badge,
  Card,
  EmptyState,
  Spinner,
  LoadMore,
  Textarea,
  buttonVariants,
  cn,
} from "@lyrashield/ui"
import { apiGet, apiGetPaginated, apiPost, apiPatch } from "@/lib/api-client"
import { formatDate } from "@/lib/date-format"
import { getFindingNextStep } from "@/lib/finding-next-step"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FindingListItem {
  id: string
  title: string
  summary: string
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  status: string
  verified: boolean
  verificationStatus: string
  verificationMethod?: string | null
  verificationReason?: string | null
  confidence: string
  cwe?: string | null
  cvssScore?: number | null
  target?: { id: string; name: string; type: string } | null
  _count?: { evidence: number; fixProposals: number }
  firstSeenAt: string
  lastSeenAt: string
}

type BadgeVariant = "default" | "success" | "danger" | "warning" | "info" | "muted"

const SEVERITY_BADGE: Record<string, BadgeVariant> = {
  CRITICAL: "danger",
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "info",
  INFO: "muted",
}

const STATUS_BADGE: Record<string, BadgeVariant> = {
  OPEN: "danger",
  FIX_READY: "info",
  PR_OPENED: "info",
  FIXED: "success",
  FIXED_PENDING_RETEST: "success",
  ACCEPTED_RISK: "muted",
  FALSE_POSITIVE: "muted",
  DUPLICATE: "muted",
}

// ---------------------------------------------------------------------------
// Severity icons — mirrors scan-detail-client.tsx SEVERITY_ICON (WCAG 1.4.1)
// ---------------------------------------------------------------------------

const SEVERITY_ICON: Record<string, typeof Shield> = {
  CRITICAL: ShieldX,
  HIGH: ShieldAlert,
  MEDIUM: Shield,
  LOW: ShieldCheck,
  INFO: ShieldCheck,
}

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "text-destructive",
  HIGH: "text-orange-600 dark:text-orange-400",
  MEDIUM: "text-amber-600 dark:text-amber-400",
  LOW: "text-sky-600 dark:text-sky-400",
  INFO: "text-muted-foreground",
}

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractEpssPercentage(technicalDetail?: string | null): string | undefined {
  const marker = "FIRST EPSS: "
  const valueStart = technicalDetail?.indexOf(marker) ?? -1
  if (!technicalDetail || valueStart < 0) return undefined

  const start = valueStart + marker.length
  const end = technicalDetail.indexOf("%", start)
  if (end < start || end - start > 6) return undefined

  const percentage = technicalDetail.slice(start, end)
  return Number.isFinite(Number(percentage)) ? `${percentage}%` : undefined
}

// ---------------------------------------------------------------------------
// FindingsClient
// ---------------------------------------------------------------------------

type SortMode = "severity" | "newest"

export function FindingsClient({
  workspaceId,
  initialData,
  initialNextCursor,
  initialSelectedFindingId,
}: {
  workspaceId: string
  initialData: FindingListItem[]
  initialNextCursor: string | null
  initialSelectedFindingId?: string
}) {
  const [findings, setFindings] = useState<FindingListItem[]>(initialData)
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor)
  const [filter, setFilter] = useState<string>("ALL")
  const [sortMode, setSortMode] = useState<SortMode>("severity")
  const [selectedFinding, setSelectedFinding] = useState<FindingListItem | null>(() =>
    initialSelectedFindingId
      ? (initialData.find((finding) => finding.id === initialSelectedFindingId) ?? null)
      : null
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFilterChange = useCallback(
    async (newFilter: string) => {
      setFilter(newFilter)
      if (newFilter === "ALL") {
        setFindings(initialData)
        setNextCursor(initialNextCursor)
        setError(null)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const params: Record<string, string> = { workspaceId }
        if (["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].includes(newFilter)) {
          params.severity = newFilter
        } else if (["OPEN", "FIXED", "ACCEPTED_RISK", "FALSE_POSITIVE"].includes(newFilter)) {
          params.status = newFilter
        } else if (newFilter === "VERIFIED") {
          params.verified = "true"
        }
        const res = await apiGetPaginated<FindingListItem>(`/api/findings`, params)
        setFindings(res.items)
        setNextCursor(res.nextCursor)
      } catch {
        setFindings([])
        setError("Failed to load findings. Please try again.")
      } finally {
        setLoading(false)
      }
    },
    [workspaceId, initialData, initialNextCursor]
  )

  // Client-side sort — severity high-first or newest first
  const sortedFindings = [...findings].sort((a, b) => {
    if (sortMode === "severity") {
      return (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99)
    }
    // newest = lastSeenAt desc
    return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
  })

  const filterChips = [
    { label: "All", value: "ALL" },
    { label: "Open", value: "OPEN" },
    { label: "Critical", value: "CRITICAL" },
    { label: "High", value: "HIGH" },
    { label: "Medium", value: "MEDIUM" },
    { label: "Fixed", value: "FIXED" },
    { label: "Verified", value: "VERIFIED" },
  ] as const

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          {/* Breadcrumb — Findings page root */}
          <nav aria-label="Breadcrumb" className="mb-1">
            <ol className="text-muted-foreground flex items-center gap-1 text-xs">
              <li>
                <Link href="/dashboard" className="hover:text-foreground">
                  Dashboard
                </Link>
              </li>
              <li aria-hidden="true">
                <ChevronRight className="h-3 w-3" />
              </li>
              <li aria-current="page" className="text-foreground font-medium">
                Findings
              </li>
            </ol>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight">Findings</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Potential and verified security findings reported by your scans
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {filterChips.map((chip) => (
            <button
              key={chip.value}
              type="button"
              onClick={() => void handleFilterChange(chip.value)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                filter === chip.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
              )}
            >
              {chip.label}
            </button>
          ))}

          {/* Sort control */}
          <div className="flex items-center gap-1 rounded-full border px-3 py-1">
            {sortMode === "severity" ? (
              <SortDesc className="text-muted-foreground h-3 w-3" aria-hidden="true" />
            ) : (
              <Calendar className="text-muted-foreground h-3 w-3" aria-hidden="true" />
            )}
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              aria-label="Sort findings"
              className="text-muted-foreground cursor-pointer bg-transparent text-xs font-medium focus:outline-none"
            >
              <option value="severity">Severity (high first)</option>
              <option value="newest">Newest</option>
            </select>
          </div>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/50 mb-4 p-4">
          <div className="text-destructive flex items-center gap-2 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => void handleFilterChange(filter)}
            >
              Retry
            </Button>
          </div>
        </Card>
      )}

      {loading && findings.length === 0 ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading findings">
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-32 w-full" />
          ))}
        </div>
      ) : findings.length === 0 ? (
        <EmptyState
          icon={Bug}
          title="No findings yet"
          description="Security vulnerabilities detected by scans will appear here. Run a scan to get started."
        />
      ) : (
        <div className={`space-y-3 ${loading ? "pointer-events-none opacity-50" : ""}`}>
          {loading && (
            <div className="flex items-center justify-center py-4">
              <Spinner />
            </div>
          )}
          {sortedFindings.map((finding) => {
            const SevIcon = SEVERITY_ICON[finding.severity] ?? Shield
            return (
              <Card
                key={finding.id}
                className="hover:shadow-card-hover cursor-pointer p-4 transition-shadow"
                onClick={() => setSelectedFinding(finding)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    setSelectedFinding(finding)
                  }
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      {/* Severity with icon (WCAG 1.4.1) */}
                      <Badge variant={SEVERITY_BADGE[finding.severity] ?? "muted"}>
                        <SevIcon
                          className={cn("mr-1 h-3 w-3", SEVERITY_COLOR[finding.severity])}
                          aria-hidden="true"
                        />
                        {finding.severity}
                      </Badge>
                      {finding.verified ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-500">
                          <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Verified
                        </span>
                      ) : (
                        <span className="text-muted-foreground flex items-center gap-1 text-xs">
                          <XCircle className="h-3 w-3" aria-hidden="true" />{" "}
                          {finding.verificationStatus.replaceAll("_", " ")}
                        </span>
                      )}
                      <Badge variant={STATUS_BADGE[finding.status] ?? "muted"}>
                        {finding.status.replace(/_/g, " ")}
                      </Badge>
                      {finding.cwe && (
                        <span className="text-muted-foreground text-xs">{finding.cwe}</span>
                      )}
                      {finding.cvssScore !== null && finding.cvssScore !== undefined && (
                        <span className="text-muted-foreground text-xs">
                          CVSS: {finding.cvssScore}
                        </span>
                      )}
                    </div>
                    <h3 className="truncate font-medium" title={finding.title}>
                      {finding.title}
                    </h3>
                    <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
                      {finding.summary}
                    </p>
                    <div className="text-muted-foreground mt-2 flex items-center gap-3 text-xs">
                      {finding.target && <span>Target: {finding.target.name}</span>}
                      {finding._count?.evidence ? (
                        <span className="flex items-center gap-1">
                          <ShieldCheck className="h-3 w-3" aria-hidden="true" />{" "}
                          {finding._count.evidence} evidence
                        </span>
                      ) : null}
                      {finding._count?.fixProposals ? (
                        <span className="flex items-center gap-1">
                          <ShieldAlert className="h-3 w-3" aria-hidden="true" />{" "}
                          {finding._count.fixProposals} fix proposals
                        </span>
                      ) : null}
                      <span>Confidence: {finding.confidence}</span>
                    </div>
                  </div>
                  <ChevronRight
                    className="text-muted-foreground h-5 w-5 shrink-0"
                    aria-hidden="true"
                  />
                </div>
              </Card>
            )
          })}

          <LoadMore
            cursor={nextCursor}
            onLoadMore={async (cursor) => {
              const params: Record<string, string> = { workspaceId, cursor }
              if (["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].includes(filter)) {
                params.severity = filter
              } else if (["OPEN", "FIXED", "ACCEPTED_RISK", "FALSE_POSITIVE"].includes(filter)) {
                params.status = filter
              } else if (filter === "VERIFIED") {
                params.verified = "true"
              }
              const res = await apiGetPaginated<FindingListItem>(`/api/findings`, params)
              return { items: res.items, nextCursor: res.nextCursor }
            }}
            onItems={(items) => setFindings((prev) => [...prev, ...items])}
            onNextCursor={setNextCursor}
          />
        </div>
      )}

      {selectedFinding && (
        <FindingDetailDrawer
          finding={selectedFinding}
          workspaceId={workspaceId}
          onClose={() => setSelectedFinding(null)}
          onStatusChange={(id, status) => {
            setFindings((prev) => prev.map((f) => (f.id === id ? { ...f, status } : f)))
            setSelectedFinding((prev) => (prev?.id === id ? { ...prev, status } : prev))
          }}
        />
      )}
    </div>
  )
}

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
  verificationReceipts?: Array<{
    id: string
    status: string
    method: string
    reason: string
    createdAt: string
  }>
  evidence?: Array<{ id: string; type: string; storageUri: string | null; redactionStatus: string }>
  fixProposals?: Array<{ id: string; status: string; summary: string }>
  retests?: Array<{ id: string; scanId: string; status: string; createdAt: string }>
  scanId?: string | null
  plainLanguage?: PlainLanguage
}

// ---------------------------------------------------------------------------
// StatusActionConfirm — inline confirm with required comment
// ---------------------------------------------------------------------------

/**
 * Inline confirm panel for status-transition actions (accept risk / false positive).
 * The comment field is required client-side for intentionality. NOTE: the current
 * /api/findings/[id] PATCH contract does not persist comments — it accepts only
 * { workspaceId, action }. The comment is collected here for UX clarity but is
 * NOT sent to the server. When the API gains a comment/reason field, wire it into
 * the patch body here.
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

  return (
    <div
      className="bg-muted/40 mt-2 space-y-2 rounded-lg border p-3"
      role="group"
      aria-label={label}
    >
      <p className="text-sm font-medium">{label}</p>
      <Textarea
        rows={2}
        placeholder="Add a comment explaining your decision (required)…"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        aria-required="true"
        aria-label="Comment"
        className="w-full"
        autoFocus
      />
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

function FindingDetailDrawer({
  finding,
  workspaceId,
  onClose,
  onStatusChange,
}: {
  finding: FindingListItem
  workspaceId: string
  onClose: () => void
  onStatusChange: (id: string, status: string) => void
}) {
  const [detail, setDetail] = useState<FindingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [showFixForm, setShowFixForm] = useState(false)
  const [fixSummary, setFixSummary] = useState("")
  const [creatingFix, setCreatingFix] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const [creatingRetest, setCreatingRetest] = useState(false)
  const [retestError, setRetestError] = useState<string | null>(null)
  const [queuedRetestScanId, setQueuedRetestScanId] = useState<string | null>(null)

  // Status transitions
  const [showAcceptRisk, setShowAcceptRisk] = useState(false)
  const [showFalsePositive, setShowFalsePositive] = useState(false)
  const [patchLoading, setPatchLoading] = useState(false)
  const [patchError, setPatchError] = useState<string | null>(null)

  // Audience mode for "What to do" tab
  const [audienceMode, setAudienceMode] = useState<AudienceMode>("developer")

  const knownExploited = detail?.technicalDetail?.includes("CISA KEV:") ?? false
  const epssSummary = extractEpssPercentage(detail?.technicalDetail)

  useEffect(() => {
    let cancelled = false
    apiGet<FindingDetail>(`/api/findings/${finding.id}?workspaceId=${workspaceId}`)
      .then((res) => {
        if (cancelled) return
        setDetail(res ?? null)
      })
      .catch(() => {
        if (cancelled) return
        setDetail(null)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [finding.id, workspaceId])

  const latestRetest = detail?.retests?.[0] ?? null
  const hasFixProposal = (detail?.fixProposals?.length ?? 0) > 0
  const nextStep = getFindingNextStep({
    latestRetestStatus: latestRetest?.status,
    hasFixProposal,
  })

  async function queueRetest() {
    if (!detail?.scanId) return
    setCreatingRetest(true)
    setRetestError(null)
    try {
      const result = await apiPost<{ scan: { id: string; status: string } }>(
        `/api/findings/${finding.id}/retests`,
        { workspaceId }
      )
      setQueuedRetestScanId(result.scan.id)
      const res = await apiGet<FindingDetail>(
        `/api/findings/${finding.id}?workspaceId=${workspaceId}`
      )
      setDetail(res ?? null)
    } catch (err) {
      setRetestError(err instanceof Error ? err.message : "Failed to create retest")
    } finally {
      setCreatingRetest(false)
    }
  }

  async function handleAcceptRisk(_comment: string) {
    // NOTE: comment is collected client-side for intentionality but the current
    // PATCH contract ({ workspaceId, action: "accept_risk" }) does not accept a
    // comment/reason field. Wire _comment into the body once the API supports it.
    setPatchLoading(true)
    setPatchError(null)
    try {
      const result = await apiPatch<{ id: string; status: string }>(`/api/findings/${finding.id}`, {
        workspaceId,
        action: "accept_risk",
      })
      onStatusChange(finding.id, result.status)
      setShowAcceptRisk(false)
      const res = await apiGet<FindingDetail>(
        `/api/findings/${finding.id}?workspaceId=${workspaceId}`
      )
      setDetail(res ?? null)
    } catch (err) {
      setPatchError(err instanceof Error ? err.message : "Failed to update status")
    } finally {
      setPatchLoading(false)
    }
  }

  async function handleFalsePositive(_comment: string) {
    // NOTE: see handleAcceptRisk — comment not yet sent to API.
    setPatchLoading(true)
    setPatchError(null)
    try {
      const result = await apiPatch<{ id: string; status: string }>(`/api/findings/${finding.id}`, {
        workspaceId,
        action: "false_positive",
      })
      onStatusChange(finding.id, result.status)
      setShowFalsePositive(false)
      const res = await apiGet<FindingDetail>(
        `/api/findings/${finding.id}?workspaceId=${workspaceId}`
      )
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
              <li
                className="text-foreground max-w-[200px] truncate font-medium"
                title={finding.title}
              >
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
          <div className="flex justify-center py-8">
            <Spinner />
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
                {finding.severity}
              </Badge>
              <Badge variant={STATUS_BADGE[finding.status] ?? "muted"}>
                {finding.status.replace(/_/g, " ")}
              </Badge>
              {finding.verified ? (
                <Badge variant="success">
                  <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />
                  Verified
                </Badge>
              ) : (
                <Badge variant="muted">{finding.verificationStatus.replaceAll("_", " ")}</Badge>
              )}
              {finding.confidence && <Badge variant="muted">{finding.confidence} confidence</Badge>}
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
            <Tabs defaultValue="what-to-do" className="w-full">
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
                  {nextStep === "REPORT" && latestRetest ? (
                    <div className="mt-2">
                      <h3 className="font-semibold">
                        Turn the retest result into an assurance report
                      </h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        This fresh retest passed. Generate an immutable report from its retained
                        result.
                      </p>
                      <Link
                        href={`/dashboard/reports?scanId=${encodeURIComponent(latestRetest.scanId)}`}
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
                      <Textarea
                        className="w-full"
                        rows={4}
                        placeholder="Describe the change you intend to make..."
                        value={fixSummary}
                        onChange={(e) => setFixSummary(e.target.value)}
                      />
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
                              const res = await apiGet<FindingDetail>(
                                `/api/findings/${finding.id}?workspaceId=${workspaceId}`
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
                  ) : nextStep === "RETEST" ? (
                    <div className="mt-2">
                      <h3 className="font-semibold">Apply the change, then run a fresh retest</h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        The proposal is recorded, but LyraShield has not changed your code. Queue
                        the retest only after you apply the fix.
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={creatingRetest || !detail.scanId}
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
                        {!detail.scanId && (
                          <span className="text-muted-foreground text-xs">
                            No scan is linked to this finding
                          </span>
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
                  <div className="space-y-2 border-t pt-2">
                    <p className="text-muted-foreground text-xs font-medium">Risk decisions</p>
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
                  </div>
                )}
                {isResolved && (
                  <div className="bg-muted/30 text-muted-foreground rounded-md border px-3 py-2 text-xs">
                    This finding is marked as{" "}
                    <span className="font-medium">{finding.status.replace(/_/g, " ")}</span>.
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
                    <pre className="bg-muted mt-1 overflow-x-auto rounded-lg p-3 text-xs whitespace-pre-wrap">
                      {detail.technicalDetail}
                    </pre>
                  </div>
                )}

                {detail.evidence && detail.evidence.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">
                      Evidence ({detail.evidence.length})
                    </h3>
                    <div className="space-y-2">
                      {detail.evidence.map((ev) => (
                        <div
                          key={ev.id}
                          className="flex items-center justify-between gap-2 rounded-lg border p-2 text-sm"
                        >
                          <div className="flex items-center gap-2">
                            <Badge variant="muted">{ev.type}</Badge>
                            {ev.storageUri && (
                              <span className="text-muted-foreground font-mono text-xs">
                                {ev.storageUri}
                              </span>
                            )}
                          </div>
                          <Badge
                            variant={ev.redactionStatus === "complete" ? "success" : "warning"}
                          >
                            {ev.redactionStatus}
                          </Badge>
                        </div>
                      ))}
                    </div>
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
                {detail.retests && detail.retests.length > 0 ? (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">Retests ({detail.retests.length})</h3>
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
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">No retests recorded yet.</p>
                )}

                {detail.fixProposals && detail.fixProposals.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">
                      Fix Proposals ({detail.fixProposals.length})
                    </h3>
                    <div className="space-y-2">
                      {detail.fixProposals.map((fp) => (
                        <div key={fp.id} className="flex items-center gap-2 text-sm">
                          <Badge variant="info">{fp.status}</Badge>
                          <span className="text-muted-foreground">{fp.summary}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {detail.verificationReceipts && detail.verificationReceipts.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">
                      Verification Receipts ({detail.verificationReceipts.length})
                    </h3>
                    <div className="space-y-2">
                      {detail.verificationReceipts.map((receipt) => (
                        <div key={receipt.id} className="rounded-lg border p-3 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={receipt.status === "VERIFIED" ? "success" : "muted"}>
                              {receipt.status.replaceAll("_", " ")}
                            </Badge>
                            <Badge variant="muted">{receipt.method.replaceAll("_", " ")}</Badge>
                            <span className="text-muted-foreground text-xs">
                              {formatDate(receipt.createdAt)}
                            </span>
                          </div>
                          <p className="text-muted-foreground mt-1 text-xs">{receipt.reason}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!detail.retests?.length &&
                  !detail.fixProposals?.length &&
                  !detail.verificationReceipts?.length && (
                    <p className="text-muted-foreground text-sm">
                      No history available for this finding yet.
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
