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
import { Button, Badge, Card, EmptyState, Spinner, LoadMore, Select, Textarea } from "@lyrashield/ui"
import { apiGet, apiGetPaginated, apiPost } from "@/lib/api-client"

export interface FindingListItem {
  id: string
  title: string
  summary: string
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  status: string
  verified: boolean
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
}: {
  workspaceId: string
  initialData: FindingListItem[]
}) {
  const [findings, setFindings] = useState<FindingListItem[]>(initialData)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>("ALL")
  const [selectedFinding, setSelectedFinding] = useState<FindingListItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFilterChange = useCallback(async (newFilter: string) => {
    setFilter(newFilter)
    if (newFilter === "ALL") {
      setFindings(initialData)
      setNextCursor(null)
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
  }, [workspaceId, initialData])

  const filters = ["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW", "OPEN", "FIXED", "VERIFIED"]

  if (loading && findings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12" aria-busy="true">
        <Spinner className="h-6 w-6" />
        <p className="text-sm text-muted-foreground">Loading findings...</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Findings</h1>
          <p className="mt-1 text-sm text-muted-foreground">Security vulnerabilities detected by your scans</p>
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Select
            value={filter}
            onChange={(e) => void handleFilterChange(e.target.value)}
            aria-label="Filter findings"
            className="w-auto"
          >
            {filters.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </Select>
        </div>
      </div>

      {error && (
        <Card className="mb-4 p-4 border-destructive/50">
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void handleFilterChange(filter)}>
              Retry
            </Button>
          </div>
        </Card>
      )}

      {findings.length === 0 ? (
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
              className="p-4 cursor-pointer hover:shadow-card-hover transition-shadow"
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
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant={SEVERITY_BADGE[finding.severity] ?? "muted"}>
                      {finding.severity}
                    </Badge>
                    {finding.verified ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Verified
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <XCircle className="h-3 w-3" aria-hidden="true" /> Unverified
                      </span>
                    )}
                    <Badge variant={STATUS_BADGE[finding.status] ?? "muted"}>
                      {finding.status.replace(/_/g, " ")}
                    </Badge>
                    {finding.cwe && (
                      <span className="text-xs text-muted-foreground">{finding.cwe}</span>
                    )}
                    {finding.cvssScore !== null && finding.cvssScore !== undefined && (
                      <span className="text-xs text-muted-foreground">CVSS: {finding.cvssScore}</span>
                    )}
                  </div>
                  <h3 className="font-medium truncate">{finding.title}</h3>
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{finding.summary}</p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                    {finding.target && <span>Target: {finding.target.name}</span>}
                    {finding._count?.evidence ? (
                      <span className="flex items-center gap-1">
                        <ShieldCheck className="h-3 w-3" aria-hidden="true" /> {finding._count.evidence} evidence
                      </span>
                    ) : null}
                    {finding._count?.fixProposals ? (
                      <span className="flex items-center gap-1">
                        <ShieldAlert className="h-3 w-3" aria-hidden="true" /> {finding._count.fixProposals} fix proposals
                      </span>
                    ) : null}
                    <span>Confidence: {finding.confidence}</span>
                  </div>
                </div>
                <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" aria-hidden="true" />
              </div>
            </Card>
          ))}

          <LoadMore
            cursor={nextCursor}
            onLoadMore={async (cursor) => {
              const res = await apiGetPaginated<FindingListItem>(`/api/findings`, { workspaceId, cursor })
              return { items: res.items as unknown[], nextCursor: res.nextCursor }
            }}
            onItems={(items) => setFindings((prev) => [...prev, ...(items as FindingListItem[])])}
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
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [onClose])


  useEffect(() => {
    let cancelled = false
    apiGet<FindingDetail>(
      `/api/findings/${finding.id}?workspaceId=${workspaceId}`
    )
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
    return () => { cancelled = true }
  }, [finding.id, workspaceId])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-end bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Finding details: ${finding.title}`}
    >
      <div
        className="w-full max-w-lg h-[80vh] overflow-y-auto bg-background rounded-t-xl shadow-premium p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">{finding.title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close finding details">Close</Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : detail ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={SEVERITY_BADGE[finding.severity] ?? "muted"}>{finding.severity}</Badge>
              <Badge variant={STATUS_BADGE[finding.status] ?? "muted"}>{finding.status}</Badge>
              {finding.verified ? (
                <Badge variant="success"><CheckCircle2 className="h-3 w-3 mr-1" aria-hidden="true" />Verified</Badge>
              ) : (
                <Badge variant="muted">Unverified</Badge>
              )}
              {finding.confidence && <Badge variant="muted">{finding.confidence} confidence</Badge>}
            </div>

            <div>
              <h3 className="text-sm font-medium mb-1">Summary</h3>
              <p className="text-sm text-muted-foreground">{detail.summary}</p>
            </div>

            {(detail.cwe || detail.cvssScore || detail.category) && (
              <div className="flex flex-wrap gap-2 text-xs">
                {detail.cwe && <Badge variant="info">{detail.cwe}</Badge>}
                {detail.cvssScore != null && <Badge variant="warning">CVSS {detail.cvssScore}</Badge>}
                {detail.category && <Badge variant="muted">{detail.category}</Badge>}
              </div>
            )}

            {detail.plainLanguage && (
              <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                <h3 className="text-sm font-semibold">Plain-Language Explanation</h3>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-0.5">What it is</p>
                  <p className="text-sm">{detail.plainLanguage.whatItIs}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-0.5">Why it matters</p>
                  <p className="text-sm">{detail.plainLanguage.whyItMatters}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-0.5">How to fix</p>
                  <p className="text-sm">{detail.plainLanguage.howToFix}</p>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1">
                  <span>Difficulty: <span className="font-medium">{detail.plainLanguage.difficulty}</span></span>
                  <span>Est. time: <span className="font-medium">{detail.plainLanguage.estimatedTimeToFix}</span></span>
                </div>
              </div>
            )}

            {detail.technicalDetail && (
              <div>
                <h3 className="text-sm font-medium mb-1">Technical Details</h3>
                <pre className="text-xs bg-muted p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">
                  {detail.technicalDetail}
                </pre>
              </div>
            )}

            {detail.exploitability && (
              <div>
                <h3 className="text-sm font-medium mb-1">Exploitability</h3>
                <p className="text-sm text-muted-foreground">{detail.exploitability}</p>
              </div>
            )}

            {detail.recommendedFix && (
              <div>
                <h3 className="text-sm font-medium mb-1">Recommended Fix</h3>
                <p className="text-sm text-muted-foreground">{detail.recommendedFix}</p>
              </div>
            )}

            {detail.businessImpact && (
              <div>
                <h3 className="text-sm font-medium mb-1">Business Impact</h3>
                <p className="text-sm text-muted-foreground">{detail.businessImpact}</p>
              </div>
            )}

            {detail.evidence && detail.evidence.length > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-1">Evidence ({detail.evidence.length})</h3>
                <div className="space-y-2">
                  {detail.evidence.map((ev) => (
                    <div key={ev.id} className="flex items-center justify-between gap-2 text-sm rounded-lg border p-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="muted">{ev.type}</Badge>
                        {ev.storageUri && <span className="text-xs text-muted-foreground font-mono">{ev.storageUri}</span>}
                      </div>
                      <Badge variant={ev.redactionStatus === "complete" ? "success" : "warning"}>{ev.redactionStatus}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {detail.fixProposals && detail.fixProposals.length > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-1">Fix Proposals ({detail.fixProposals.length})</h3>
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
                <h3 className="text-sm font-medium mb-1">Retests ({detail.retests.length})</h3>
                <div className="space-y-2">
                  {detail.retests.map((rt) => (
                    <div key={rt.id} className="flex items-center gap-2 text-sm">
                      <Badge variant={rt.status === "passed" ? "success" : rt.status === "failed" ? "danger" : "info"}>
                        {rt.status}
                      </Badge>
                      <span className="text-muted-foreground">{new Date(rt.createdAt).toLocaleDateString()}</span>
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
                        scanId: detail.scanId,
                      })
                      const res = await apiGet<FindingDetail>(`/api/findings/${finding.id}?workspaceId=${workspaceId}`)
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
                      <Spinner /> Retesting...
                    </span>
                  ) : (
                    "Retest Finding"
                  )}
                </Button>
                {!detail.scanId && (
                  <span className="text-xs text-muted-foreground">No scan linked to this finding</span>
                )}
              </div>
              {retestError && (
                <p className="mt-2 text-xs text-destructive">{retestError}</p>
              )}
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
                  {fixError && (
                    <p className="text-xs text-destructive">{fixError}</p>
                  )}
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
                            const res = await apiGet<FindingDetail>(`/api/findings/${finding.id}?workspaceId=${workspaceId}`)
                            setDetail(res ?? null)
                          } catch {
                            setFixError("Proposal created but failed to reload details. Close and reopen the drawer.")
                          } finally {
                            setLoading(false)
                          }
                        } catch (err) {
                          setFixError(err instanceof Error ? err.message : "Failed to create fix proposal")
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
                      onClick={() => { setShowFixForm(false); setFixSummary(""); setFixError(null) }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowFixForm(true)}
                >
                  <Wrench className="h-4 w-4 mr-1" aria-hidden="true" />
                  Generate Fix Proposal
                </Button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Failed to load finding details.</p>
        )}
      </div>
    </div>
  )
}
