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
} from "lucide-react"
import { Button, Badge, Card, EmptyState, Spinner, LoadMore } from "@lyrashield/ui"
import { apiGet, apiGetPaginated } from "@/lib/api-client"

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
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Findings</h1>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <select
            value={filter}
            onChange={(e) => void handleFilterChange(e.target.value)}
            aria-label="Filter findings"
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          >
            {filters.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
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
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant={SEVERITY_BADGE[finding.severity] ?? "muted"}>
                      {finding.severity}
                    </Badge>
                    {finding.verified ? (
                      <span className="flex items-center gap-1 text-xs text-green-600">
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

interface FindingDetail {
  id: string
  title: string
  summary: string
  technicalDetail?: string | null
  recommendedFix?: string | null
  businessImpact?: string | null
  evidence?: Array<{ id: string; type: string; storageUri: string | null; redactionStatus: string }>
  fixProposals?: Array<{ id: string; status: string; summary: string }>
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
            <div>
              <h3 className="text-sm font-medium mb-1">Summary</h3>
              <p className="text-sm text-muted-foreground">{detail.summary}</p>
            </div>

            {detail.technicalDetail && (
              <div>
                <h3 className="text-sm font-medium mb-1">Technical Details</h3>
                <pre className="text-xs bg-muted p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">
                  {detail.technicalDetail}
                </pre>
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
                    <div key={ev.id} className="flex items-center gap-2 text-sm">
                      <Badge variant="muted">{ev.type}</Badge>
                      <span className="text-muted-foreground">{ev.redactionStatus}</span>
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
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Failed to load finding details.</p>
        )}
      </div>
    </div>
  )
}
