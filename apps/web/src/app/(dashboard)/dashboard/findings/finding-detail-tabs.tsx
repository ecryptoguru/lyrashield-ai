"use client"

import { CreateFixPrAction } from "@/components/create-fix-pr-action"
import Link from "next/link"
import { z } from "zod"
import { Badge, Button, Spinner } from "@lyrashield/ui"
import { formatDate } from "@/lib/date-format"
import { getVerificationStatusLabel } from "@/lib/enum-labels"
import { humanizeToken, evidenceTypeLabel } from "@/lib/labels"
import {
  buildRemediationTimeline,
  type RemediationTimelineEvent,
  type TimelineRetestInput,
} from "@/lib/finding-remediation-timeline"
import { TabsContent } from "@/components/ui/tabs"
import type { FindingListItem } from "./findings-client"
import type { FindingDetail } from "./finding-detail-drawer"

type HistoryCollection = keyof NonNullable<FindingDetail["historyPagination"]>

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

export function FindingTechnicalTab({
  detail,
  knownExploited,
  epssSummary,
  historyLoading,
  loadMoreHistory,
}: {
  detail: FindingDetail
  knownExploited: boolean
  epssSummary: string | undefined
  historyLoading: Set<HistoryCollection>
  loadMoreHistory: (collection: HistoryCollection) => Promise<void>
}) {
  return (
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
          {detail.cvssScore != null && <Badge variant="warning">CVSS {detail.cvssScore}</Badge>}
          {detail.category && <Badge variant="muted">{humanizeToken(detail.category)}</Badge>}
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
            Evidence ({detail.historyPagination?.evidence.total ?? detail.evidence.length})
          </h3>
          <div className="space-y-2">
            {detail.evidence.map((ev) => (
              <div
                key={ev.id}
                className="flex items-center justify-between gap-2 rounded-lg border p-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="muted">{evidenceTypeLabel(ev.type)}</Badge>
                </div>
                <Badge variant={ev.redactionStatus === "complete" ? "success" : "warning"}>
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

      {detail.evidenceInsights && (
        <div className="rounded-lg border p-3">
          <h3 className="text-sm font-medium">Engine-declared evidence</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Assertions the engine recorded for this finding. They are evidence about the
            engine&apos;s own view — not LyraShield verification.
          </p>
          <dl className="mt-2 space-y-2 text-sm">
            {detail.evidenceInsights.advisoryCvss != null && (
              <div className="flex flex-wrap gap-2">
                <dt className="text-muted-foreground text-xs">Advisory severity</dt>
                <dd>
                  <Badge variant="warning">
                    Advisory CVSS {detail.evidenceInsights.advisoryCvss.score}
                  </Badge>
                </dd>
              </div>
            )}
            {detail.evidenceInsights.advisoryCvss?.vector && (
              <div>
                <dt className="text-muted-foreground text-xs">Advisory vector</dt>
                <dd className="text-muted-foreground mt-0.5 break-all font-mono text-xs">
                  {detail.evidenceInsights.advisoryCvss.vector}
                </dd>
              </div>
            )}
            {detail.evidenceInsights.advisoryCvss?.metric_reasoning && (
              <div>
                <dt className="text-muted-foreground text-xs">Advisory metric reasoning</dt>
                <dd className="text-muted-foreground mt-0.5 text-xs">
                  {detail.evidenceInsights.advisoryCvss.metric_reasoning}
                </dd>
              </div>
            )}
            {detail.evidenceInsights.engineConfidence && (
              <div className="flex flex-wrap gap-2">
                <dt className="text-muted-foreground text-xs">Engine confidence</dt>
                <dd>
                  <Badge variant="muted">
                    {detail.evidenceInsights.engineConfidence} (engine-declared)
                  </Badge>
                </dd>
              </div>
            )}
            {detail.evidenceInsights.engineVerificationState && (
              <div className="flex flex-wrap gap-2">
                <dt className="text-muted-foreground text-xs">Engine claim</dt>
                <dd>
                  <Badge variant="muted">
                    {detail.evidenceInsights.engineVerificationState} (engine-declared)
                  </Badge>
                </dd>
              </div>
            )}
            {detail.evidenceInsights.contextualCvssReasoning && (
              <div>
                <dt className="text-muted-foreground text-xs">Contextual severity reasoning</dt>
                <dd className="text-muted-foreground mt-0.5 text-xs">
                  {detail.evidenceInsights.contextualCvssReasoning}
                </dd>
              </div>
            )}
            {detail.evidenceInsights.confidenceRationale && (
              <div>
                <dt className="text-muted-foreground text-xs">Confidence rationale</dt>
                <dd className="text-muted-foreground mt-0.5 text-xs">
                  {detail.evidenceInsights.confidenceRationale}
                </dd>
              </div>
            )}
            {detail.evidenceInsights.counterevidence && (
              <div>
                <dt className="text-muted-foreground text-xs">Counterevidence</dt>
                <dd className="text-muted-foreground mt-0.5 whitespace-pre-wrap text-xs">
                  {detail.evidenceInsights.counterevidence}
                </dd>
              </div>
            )}
            {detail.evidenceInsights.severityChangeConditions && (
              <div>
                <dt className="text-muted-foreground text-xs">Severity change conditions</dt>
                <dd className="text-muted-foreground mt-0.5 whitespace-pre-wrap text-xs">
                  {detail.evidenceInsights.severityChangeConditions}
                </dd>
              </div>
            )}
            {detail.evidenceInsights.assumptions && (
              <div>
                <dt className="text-muted-foreground text-xs">Assumptions</dt>
                <dd className="text-muted-foreground mt-0.5 whitespace-pre-wrap text-xs">
                  {detail.evidenceInsights.assumptions}
                </dd>
              </div>
            )}
            {(detail.evidenceInsights.evidenceWarnings?.length ?? 0) > 0 && (
              <div>
                <dt className="text-muted-foreground text-xs">Evidence warnings</dt>
                <dd>
                  <ul className="mt-0.5 list-inside list-disc text-xs text-amber-600">
                    {detail.evidenceInsights.evidenceWarnings!.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {detail.verificationReason && (
        <div className="bg-muted/30 rounded-lg border p-3">
          <h3 className="text-sm font-medium">Verification state</h3>
          <p className="text-muted-foreground mt-1 text-sm">{detail.verificationReason}</p>
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
  )
}

export function FindingHistoryTab({
  detail,
  finding,
  canCreatePr,
  workspaceId,
  historyLoading,
  loadMoreHistory,
  historyError,
}: {
  detail: FindingDetail
  finding: FindingListItem
  canCreatePr: boolean
  workspaceId: string
  historyLoading: Set<HistoryCollection>
  loadMoreHistory: (collection: HistoryCollection) => Promise<void>
  historyError: string | null
}) {
  return (
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
                    rt.status === "passed" ? "success" : rt.status === "failed" ? "danger" : "info"
                  }
                >
                  {humanizeToken(rt.status)}
                </Badge>
                <Link
                  href={`/dashboard/scans/${encodeURIComponent(rt.scanId)}`}
                  className="text-primary text-xs hover:underline"
                >
                  View scan
                </Link>
                <span className="text-muted-foreground text-xs">{formatDate(rt.createdAt)}</span>
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
          opened as PRs, merged, retested and verified.
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
        Built only from stored receipts. A proposed fix is not an applied fix and a merged PR is not
        verification.
      </p>
    </div>
  )
}
