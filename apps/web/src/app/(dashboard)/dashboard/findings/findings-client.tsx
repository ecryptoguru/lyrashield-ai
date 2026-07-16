"use client"

import { useState, useEffect, useCallback } from "react"
import {
  Bug,
  ShieldCheck,
  ShieldAlert,
  Filter,
  ChevronRight,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Wrench,
} from "lucide-react"
import {
  Button,
  Badge,
  Card,
  EmptyState,
  Spinner,
  LoadMore,
  Select,
  Textarea,
} from "@lyrashield/ui"
import { apiGet, apiGetPaginated, apiPost } from "@/lib/api-client"
import { formatDate } from "@/lib/date-format"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"

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

export function FindingsClient({
  workspaceId,
  initialData,
  initialNextCursor,
}: {
  workspaceId: string
  initialData: FindingListItem[]
  initialNextCursor: string | null
}) {
  const [findings, setFindings] = useState<FindingListItem[]>(initialData)
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor)
  const [filter, setFilter] = useState<string>("ALL")
  const [selectedFinding, setSelectedFinding] = useState<FindingListItem | null>(null)
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

  const filters = ["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW", "OPEN", "FIXED", "VERIFIED"]

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Findings</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Security vulnerabilities detected by your scans
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Filter className="text-muted-foreground h-4 w-4" aria-hidden="true" />
          <Select
            value={filter}
            onChange={(e) => void handleFilterChange(e.target.value)}
            aria-label="Filter findings"
            className="w-auto"
          >
            {filters.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/50 mb-4 p-4">
          <div className="text-destructive flex items-center gap-2 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
            <Button
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
          {findings.map((finding) => (
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
                    <Badge variant={SEVERITY_BADGE[finding.severity] ?? "muted"}>
                      {finding.severity}
                    </Badge>
                    {finding.verified ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
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
          ))}

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
        />
      )}
    </div>
  )
}

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
  retests?: Array<{ id: string; status: string; createdAt: string }>
  scanId?: string | null
  plainLanguage?: PlainLanguage
}

function FindingDetailDrawer({
  finding,
  workspaceId,
  onClose,
}: {
  finding: FindingListItem
  workspaceId: string
  onClose: () => void
}) {
  const [detail, setDetail] = useState<FindingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [showFixForm, setShowFixForm] = useState(false)
  const [fixSummary, setFixSummary] = useState("")
  const [creatingFix, setCreatingFix] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const [creatingRetest, setCreatingRetest] = useState(false)
  const [retestError, setRetestError] = useState<string | null>(null)

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

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full max-w-lg overflow-y-auto p-6 sm:max-w-lg">
        <SheetHeader className="mb-4 p-0 pr-8 text-left">
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
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={SEVERITY_BADGE[finding.severity] ?? "muted"}>
                {finding.severity}
              </Badge>
              <Badge variant={STATUS_BADGE[finding.status] ?? "muted"}>{finding.status}</Badge>
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

            <div>
              <h3 className="mb-1 text-sm font-medium">Summary</h3>
              <p className="text-muted-foreground text-sm">{detail.summary}</p>
            </div>

            {detail.verificationReason && (
              <div className="bg-muted/30 rounded-lg border p-3">
                <h3 className="text-sm font-medium">Verification state</h3>
                <p className="text-muted-foreground mt-1 text-sm">{detail.verificationReason}</p>
              </div>
            )}

            {detail.verificationReceipts && detail.verificationReceipts.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium">
                  Verification receipts ({detail.verificationReceipts.length})
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

            {(detail.cwe || detail.cvssScore || detail.category) && (
              <div className="flex flex-wrap gap-2 text-xs">
                {detail.cwe && <Badge variant="info">{detail.cwe}</Badge>}
                {detail.cvssScore != null && (
                  <Badge variant="warning">CVSS {detail.cvssScore}</Badge>
                )}
                {detail.category && <Badge variant="muted">{detail.category}</Badge>}
              </div>
            )}

            {detail.plainLanguage && (
              <div className="bg-muted/30 space-y-3 rounded-lg border p-4">
                <h3 className="text-sm font-semibold">Plain-Language Explanation</h3>
                <div>
                  <p className="text-muted-foreground mb-0.5 text-xs font-medium">What it is</p>
                  <p className="text-sm">{detail.plainLanguage.whatItIs}</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5 text-xs font-medium">Why it matters</p>
                  <p className="text-sm">{detail.plainLanguage.whyItMatters}</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5 text-xs font-medium">How to fix</p>
                  <p className="text-sm">{detail.plainLanguage.howToFix}</p>
                </div>
                <div className="text-muted-foreground flex items-center gap-3 pt-1 text-xs">
                  <span>
                    Difficulty:{" "}
                    <span className="font-medium">{detail.plainLanguage.difficulty}</span>
                  </span>
                  <span>
                    Est. time:{" "}
                    <span className="font-medium">{detail.plainLanguage.estimatedTimeToFix}</span>
                  </span>
                </div>
              </div>
            )}

            {detail.technicalDetail && (
              <div>
                <h3 className="mb-1 text-sm font-medium">Technical Details</h3>
                <pre className="bg-muted overflow-x-auto rounded-lg p-3 text-xs whitespace-pre-wrap">
                  {detail.technicalDetail}
                </pre>
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

            {detail.evidence && detail.evidence.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium">Evidence ({detail.evidence.length})</h3>
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
                      <Badge variant={ev.redactionStatus === "complete" ? "success" : "warning"}>
                        {ev.redactionStatus}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {detail.fixProposals && detail.fixProposals.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium">
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

            {detail.retests && detail.retests.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium">Retests ({detail.retests.length})</h3>
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
                      <span className="text-muted-foreground">{formatDate(rt.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="border-t pt-4">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={creatingRetest || !detail.scanId}
                  onClick={async () => {
                    if (!detail.scanId) return
                    setCreatingRetest(true)
                    setRetestError(null)
                    try {
                      await apiPost(`/api/findings/${finding.id}/retests`, {
                        workspaceId,
                      })
                      const res = await apiGet<FindingDetail>(
                        `/api/findings/${finding.id}?workspaceId=${workspaceId}`
                      )
                      setDetail(res ?? null)
                    } catch (err) {
                      setRetestError(err instanceof Error ? err.message : "Failed to create retest")
                    } finally {
                      setCreatingRetest(false)
                    }
                  }}
                >
                  {creatingRetest ? (
                    <span className="flex items-center gap-2">
                      <Spinner /> Queuing retest...
                    </span>
                  ) : (
                    "Queue Retest"
                  )}
                </Button>
                {!detail.scanId && (
                  <span className="text-muted-foreground text-xs">
                    No scan linked to this finding
                  </span>
                )}
              </div>
              {retestError && <p className="text-destructive mt-2 text-xs">{retestError}</p>}
            </div>

            <div className="border-t pt-4">
              {showFixForm ? (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium">Generate Fix Proposal</h3>
                  <Textarea
                    className="w-full"
                    rows={3}
                    placeholder="Describe the proposed fix..."
                    value={fixSummary}
                    onChange={(e) => setFixSummary(e.target.value)}
                  />
                  {fixError && <p className="text-destructive text-xs">{fixError}</p>}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={creatingFix || fixSummary.length < 10}
                      onClick={async () => {
                        setCreatingFix(true)
                        setFixError(null)
                        try {
                          await apiPost(`/api/findings/${finding.id}/fix-proposals`, {
                            workspaceId,
                            summary: fixSummary,
                          })
                          setShowFixForm(false)
                          setFixSummary("")
                          setDetail(null)
                          setLoading(true)
                          try {
                            const res = await apiGet<FindingDetail>(
                              `/api/findings/${finding.id}?workspaceId=${workspaceId}`
                            )
                            setDetail(res ?? null)
                          } catch {
                            setFixError(
                              "Proposal created but failed to reload details. Close and reopen the drawer."
                            )
                          } finally {
                            setLoading(false)
                          }
                        } catch (err) {
                          setFixError(
                            err instanceof Error ? err.message : "Failed to create fix proposal"
                          )
                        } finally {
                          setCreatingFix(false)
                        }
                      }}
                    >
                      {creatingFix ? <Spinner /> : "Create Proposal"}
                    </Button>
                    <Button
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
              ) : (
                <Button size="sm" variant="outline" onClick={() => setShowFixForm(true)}>
                  <Wrench className="mr-1 h-4 w-4" aria-hidden="true" />
                  Generate Fix Proposal
                </Button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Failed to load finding details.</p>
        )}
      </SheetContent>
    </Sheet>
  )
}
