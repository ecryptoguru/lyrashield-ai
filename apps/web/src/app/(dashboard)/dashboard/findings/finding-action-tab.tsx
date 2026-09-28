"use client"

import { useId, useState } from "react"
import Link from "next/link"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ArrowRight, Wrench } from "lucide-react"
import { Button, Textarea, FormField, Spinner, buttonVariants } from "@lyrashield/ui"
import { reportsHref } from "@/lib/finding-list-params"
import { getFindingNextAction } from "@/lib/finding-next-step"
import { FINDING_STATUS_LABELS } from "@/lib/enum-labels"
import { humanizeToken } from "@/lib/labels"
import { TabsContent } from "@/components/ui/tabs"
import type { FindingListItem } from "./findings-client"
import type { FindingDetail } from "./finding-detail-drawer"

export type AudienceMode =
  "founder" | "developer" | "security-engineer" | "enterprise-admin" | "auditor"

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
      return `As a business leader, this ${severity.toLowerCase()} finding ("${title}") represents a risk to your product, customers or compliance posture. Your engineering team can resolve it — the key action is prioritising and tracking it.`
    case "developer":
      return `This is a ${severity.toLowerCase()} finding in your codebase. The steps below give you a direct path to fix it. Focus on the "How to fix" section for implementation guidance.`
    case "security-engineer":
      return `${severity} severity finding. Review CWE, CVSS and EPSS data in the Technical tab for triage. The fix guidance below is a starting point — validate against your threat model.`
    case "enterprise-admin":
      return `This ${severity.toLowerCase()} finding may affect compliance, SLAs or vendor risk assessments. Ensure it is assigned to an owner and that resolution is tracked against your remediation SLA.`
    case "auditor":
      return `For audit purposes, this ${severity.toLowerCase()} finding ("${title}") should be referenced in your risk register. Verification receipts and retest history are available in the History tab.`
  }
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

export function FindingActionTab({
  detail,
  finding,
  targetId,
  audienceMode,
  setAudienceMode,
  showFixForm,
  setShowFixForm,
  fixSummary,
  setFixSummary,
  creatingFix,
  fixError,
  setFixError,
  saveFixProposal,
  creatingRetest,
  retestError,
  queuedRetestScanId,
  queueRetest,
  setDetailTab,
  showAcceptRisk,
  setShowAcceptRisk,
  showFalsePositive,
  setShowFalsePositive,
  patchLoading,
  patchError,
  setPatchError,
  handleAcceptRisk,
  handleFalsePositive,
}: {
  detail: FindingDetail
  finding: FindingListItem
  targetId?: string
  audienceMode: AudienceMode
  setAudienceMode: (mode: AudienceMode) => void
  showFixForm: boolean
  setShowFixForm: (open: boolean) => void
  fixSummary: string
  setFixSummary: (summary: string) => void
  creatingFix: boolean
  fixError: string | null
  setFixError: (error: string | null) => void
  saveFixProposal: () => Promise<void>
  creatingRetest: boolean
  retestError: string | null
  queuedRetestScanId: string | null
  queueRetest: () => Promise<void>
  setDetailTab: (tab: string) => void
  showAcceptRisk: boolean
  setShowAcceptRisk: (open: boolean) => void
  showFalsePositive: boolean
  setShowFalsePositive: (open: boolean) => void
  patchLoading: boolean
  patchError: string | null
  setPatchError: (error: string | null) => void
  handleAcceptRisk: (comment: string) => Promise<void>
  handleFalsePositive: (comment: string) => Promise<void>
}) {
  const latestRetest = detail.retests?.[0] ?? null
  const nextAction = getFindingNextAction({
    status: finding.status,
    latestRetestStatus: latestRetest?.status,
    hasEvidence: (detail.evidence?.length ?? 0) > 0,
    hasFixProposal: (detail.fixProposals?.length ?? 0) > 0,
  })
  const nextStep = nextAction.action
  const isResolved = finding.status === "ACCEPTED_RISK" || finding.status === "FALSE_POSITIVE"

  return (
    <TabsContent value="what-to-do" className="mt-4 space-y-4">
      {/* Audience mode selector */}
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
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
          className="bg-background focus:ring-ring w-full min-w-0 rounded-md border px-2 py-1 text-xs focus:ring-2 focus:outline-none sm:w-auto"
          aria-label="Select audience mode for plain-language explanation"
        >
          {(Object.entries(AUDIENCE_LABELS) as [AudienceMode, string][]).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {/* Next-step action panel */}
      <div className="border-primary/30 bg-primary/5 rounded-lg border p-4">
        <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">Next step</p>
        {nextStep === "NONE" ? (
          <p className="text-muted-foreground mt-2 text-sm">{nextAction.reason}</p>
        ) : nextStep === "REPORT" && latestRetest ? (
          <div className="mt-2">
            <h3 className="font-semibold">Turn the retest result into an assurance report</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              This fresh retest passed. Generate an immutable report from its retained result.
            </p>
            <Link
              href={reportsHref({
                scanId: latestRetest.scanId,
                ...(targetId ? { targetId } : {}),
              })}
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
              The fresh scan will determine whether the recorded change is retest-confirmed or
              remains inconclusive.
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
                Review and edit this plan before saving it. Creating a proposal does not change your
                code.
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
                onClick={() => void saveFixProposal()}
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
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowFixForm(true)}>
                Create fix proposal
              </Button>
            </div>
          </div>
        ) : nextStep === "RETEST" ? (
          <div className="mt-2">
            <h3 className="font-semibold">Apply the change, then run a fresh retest</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              The proposal is recorded, but LyraShield has not changed your code. Queue the retest
              only after you apply the fix.
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
                    A fresh retest needs a linked server scan. Run a scan for this target first or
                    check that this finding came from a completed scan rather than an imported
                    report.
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
            {retestError && <p className="text-destructive mt-2 text-xs">{retestError}</p>}
          </div>
        ) : (
          <div className="mt-2">
            <h3 className="font-semibold">Review the guidance and record your plan</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Use the evidence and recommended fix below, then save the change you intend to make.
            </p>
            <Button
              type="button"
              size="sm"
              className="mt-3"
              onClick={() => {
                setFixSummary(detail.recommendedFix ?? detail.plainLanguage?.howToFix ?? "")
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
                Difficulty: <span className="font-medium">{detail.plainLanguage.difficulty}</span>
              </span>
              <span>
                Est. time:{" "}
                <span className="font-medium">{detail.plainLanguage.estimatedTimeToFix}</span>
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
  )
}
