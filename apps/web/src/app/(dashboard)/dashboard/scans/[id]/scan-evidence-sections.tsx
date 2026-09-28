"use client"

import { ShieldAlert } from "lucide-react"
import { Badge, Card } from "@lyrashield/ui"
import { safeApiErrorMessage } from "@/components/api-error-card"
import { getScanModeLabel, getTargetTypeLabel } from "@/lib/enum-labels"
import { humanizeToken } from "@/lib/labels"
import { getScanPresentation } from "@/lib/scan-presentation"
import { getScannerCoverageWarnings } from "@/lib/scan-coverage"
import { getScanReviewProfile } from "@/lib/scan-review-profile"
import { SCANNER_LABELS } from "./scan-detail-presentation"
import type { ScanData } from "./scan-detail-types"

type CoverageReceipt = ScanData["integrity"]["coverage"][number]

export function ScanEvidenceSections({
  scan,
  presentation,
  coverageWarnings,
  controlCoverage,
  controlOutcomeCounts,
}: {
  scan: ScanData
  presentation: ReturnType<typeof getScanPresentation>
  coverageWarnings: ReturnType<typeof getScannerCoverageWarnings>
  controlCoverage: CoverageReceipt[]
  controlOutcomeCounts: Record<string, number>
}) {
  const relayAuditEvent = [...scan.events].reverse().find((e) => e.stage === "relay_audit")
  const relayScopeEvent = [...scan.events].reverse().find((e) => e.stage === "relay_scope")
  const relayStats =
    relayAuditEvent || relayScopeEvent
      ? {
          requests:
            typeof relayAuditEvent?.metadata === "object" &&
            relayAuditEvent.metadata &&
            typeof (relayAuditEvent.metadata as Record<string, unknown>).entries === "number"
              ? ((relayAuditEvent.metadata as Record<string, unknown>).entries as number)
              : null,
          hosts:
            typeof relayScopeEvent?.metadata === "object" &&
            relayScopeEvent.metadata &&
            Array.isArray((relayScopeEvent.metadata as Record<string, unknown>).hosts)
              ? ((relayScopeEvent.metadata as Record<string, unknown>).hosts as unknown[]).filter(
                  (h): h is string => typeof h === "string"
                )
              : [],
        }
      : null
  const reviewProfile = getScanReviewProfile(scan.events)
  const hasLimitedCoverage = coverageWarnings.length > 0

  return (
    <>
      {scan.target && (
        <Card className="mb-6 p-4">
          <h2 className="mb-2 text-sm font-semibold">Target</h2>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{scan.target.name}</span>
            <Badge variant="muted">{getTargetTypeLabel(scan.target.type)}</Badge>
            {scan.target.repoFullName && (
              <span className="text-muted-foreground">{scan.target.repoFullName}</span>
            )}
            {scan.target.url && (
              <a
                href={scan.target.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {scan.target.url}
              </a>
            )}
          </div>
        </Card>
      )}

      {presentation.showFailureDetails && (
        <div
          role="alert"
          className="border-destructive/50 bg-destructive/10 mb-6 border-l-2 p-4 text-sm"
        >
          <p className="font-semibold">{presentation.headline}</p>
          <p className="text-foreground/80 mt-1">{presentation.description}</p>
          {scan.errorMessage && (
            <details className="text-foreground mt-3">
              <summary className="cursor-pointer font-medium">Failure details</summary>
              <p className="mt-2 wrap-break-word">
                {presentation.recoveryAction === "usage"
                  ? "Workspace minutes and grace were exhausted."
                  : [
                      scan.errorCategory ? `${safeApiErrorMessage(scan.errorCategory)}: ` : "",
                      scan.status === "STOPPED_BUDGET" || scan.errorCategory === "BUDGET_EXCEEDED"
                        ? "The protected scan limit was reached."
                        : safeApiErrorMessage(scan.errorMessage),
                    ].join("")}
              </p>
            </details>
          )}
        </div>
      )}

      {scan.integrity.urlExecution && (
        <Card
          className="mb-6 p-4"
          role="region"
          aria-labelledby="url-execution-heading"
          aria-describedby="url-execution-limitations"
        >
          <h2 id="url-execution-heading" className="font-semibold">
            URL execution scope
          </h2>
          <p className="text-muted-foreground mt-1 text-sm" id="url-execution-limitations">
            {renderUrlExecutionLine(scan.integrity.urlExecution)}
          </p>
          {Array.isArray(scan.integrity.urlExecution.issueCodes) &&
            scan.integrity.urlExecution.issueCodes.length > 0 && (
              <p className="mt-2 text-sm text-amber-600" role="status" aria-live="polite">
                Coverage limited: {scan.integrity.urlExecution.issueCodes.join(", ")}
              </p>
            )}
          {relayStats && (
            <p className="text-muted-foreground mt-2 text-xs">
              Engine traffic ran through the scan-scoped relay
              {relayStats.hosts.length > 0 && ` to ${relayStats.hosts.join(", ")}`}
              {relayStats.requests !== null &&
                ` — ${relayStats.requests} audited request${relayStats.requests === 1 ? "" : "s"}`}
              .
            </p>
          )}
          <p className="text-muted-foreground mt-2 text-xs">
            This public, non-mutating review did not authenticate or validate exploitability.
          </p>
        </Card>
      )}

      {scan.executionPlan && (
        <Card className="mb-6 p-4" aria-labelledby="scan-plan-heading">
          <h2 id="scan-plan-heading" className="font-semibold">
            Scope and plan
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            The immutable plan recorded at creation — it cannot be widened afterward.
          </p>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground text-xs">Workflow</dt>
              <dd className="mt-0.5 font-medium">
                {scan.executionPlan.workflow === "REVIEW_CHANGES"
                  ? "Scan changes"
                  : scan.executionPlan.workflow === "AUTHENTICATED_ASSESSMENT"
                    ? "Authenticated assessment"
                    : "Scan target"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Depth</dt>
              <dd className="mt-0.5 font-medium">{getScanModeLabel(scan.executionPlan.depth)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Effective scope</dt>
              <dd className="mt-0.5 font-medium">
                {scan.executionPlan.scope === "DIFF"
                  ? "Recorded diff"
                  : scan.executionPlan.scope === "LIVE"
                    ? "Live target"
                    : "Snapshot"}
                {scan.executionPlan.baseRevision
                  ? ` (${scan.executionPlan.baseRevision.slice(0, 7)}…${(scan.executionPlan.sourceRevision ?? "").slice(0, 7)})`
                  : scan.executionPlan.sourceRevision
                    ? ` @ ${scan.executionPlan.sourceRevision.slice(0, 7)}`
                    : ""}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Limits</dt>
              <dd className="mt-0.5 font-medium">
                {[
                  scan.executionPlan.maxDurationMinutes
                    ? `Up to ${scan.executionPlan.maxDurationMinutes} minutes`
                    : null,
                  scan.executionPlan.maxRequests
                    ? `${scan.executionPlan.maxRequests} requests`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Bounded scan"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Supporting files</dt>
              <dd className="mt-0.5 font-medium">
                {scan.executionPlan.attachmentCount > 0
                  ? `${scan.executionPlan.attachmentCount} recorded input${
                      scan.executionPlan.attachmentCount === 1 ? "" : "s"
                    }`
                  : "None"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Authorization</dt>
              <dd className="mt-0.5 font-medium">
                {scan.executionPlan.authorizationRequired
                  ? "Delegated authorization recorded"
                  : "Workspace membership"}
              </dd>
            </div>
          </dl>
          {scan.executionPlan.capabilities.length > 0 && (
            <details className="mt-3">
              <summary className="text-muted-foreground cursor-pointer text-xs font-medium">
                Applicable checks
              </summary>
              <ul className="text-muted-foreground mt-1 list-inside list-disc text-xs">
                {scan.executionPlan.capabilities.map((capability) => (
                  <li key={capability}>{capability}</li>
                ))}
              </ul>
            </details>
          )}
        </Card>
      )}

      {hasLimitedCoverage && (
        <section
          aria-labelledby="coverage-warning-heading"
          className="mb-6 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
            <div className="min-w-0">
              <h2 id="coverage-warning-heading" className="font-semibold">
                Some scanner coverage was limited
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Results are available, but the checks below could not fully evaluate every supported
                input. Review them before treating this scan as a complete clean result.
              </p>
              <ul className="mt-3 space-y-2 text-sm">
                {coverageWarnings.map((warning, index) => (
                  <li
                    key={`${warning.scanner}-${warning.status}-${warning.subject ?? ""}-${index}`}
                    className="bg-background/40 rounded-md border border-amber-500/30 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {SCANNER_LABELS[warning.scanner] ?? warning.scanner}
                      </span>
                      <Badge variant="warning">{humanizeToken(warning.status)}</Badge>
                      {warning.subject && (
                        <span className="text-muted-foreground wrap-break-word">
                          {warning.subject}
                        </span>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1">{warning.reason}</p>
                    {warning.discovery && (
                      <div className="text-muted-foreground mt-2 text-xs">
                        <p>
                          Scanned {warning.discovery.scannedFiles} of{" "}
                          {warning.discovery.eligibleFiles} eligible files;{" "}
                          {warning.discovery.skippedFiles} skipped.
                        </p>
                        {warning.discovery.representativeSkippedPaths.length > 0 && (
                          <details className="mt-1">
                            <summary className="text-foreground cursor-pointer font-medium">
                              Review skipped-path sample
                            </summary>
                            <ul className="mt-1 list-disc space-y-0.5 pl-5">
                              {warning.discovery.representativeSkippedPaths.map((filePath) => (
                                <li key={filePath} className="wrap-break-word font-mono">
                                  {filePath}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {(() => {
        const quality = scan.integrity.quality as
          | {
              version?: string
              facts?: {
                findings?: {
                  total?: number
                  validatedCount?: number
                  verifiedCount?: number
                  nonConclusiveCount?: number
                }
                coverage?: {
                  receiptsTotal?: number
                  engineDeclaredReceipts?: number
                  connectorReceipts?: number
                }
                evidence?: { ingestionWarningCount?: number }
              }
              estimates?: {
                assessedReceiptRatio?: { kind?: string; value?: number | null; basis?: string }
                verifiedFindingRatio?: { kind?: string; value?: number | null; basis?: string }
              }
            }
          | null
          | undefined
        if (!quality?.facts) return null
        const findings = quality.facts.findings
        const coverage = quality.facts.coverage
        return (
          <Card className="mb-6 p-4" aria-labelledby="quality-surface-heading">
            <div>
              <h2 id="quality-surface-heading" className="font-semibold">
                Evidence quality
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Measured facts computed from this scan&apos;s stored evidence. Ratios are
                heuristics, not accuracy claims — model-declared coverage is counted separately and
                never treated as a measured outcome.
              </p>
            </div>
            <dl className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border p-3">
                <dt className="text-muted-foreground text-xs">Findings (measured)</dt>
                <dd className="mt-1 text-sm font-medium">
                  {findings?.total ?? 0} retained · {findings?.verifiedCount ?? 0} verified ·{" "}
                  {findings?.validatedCount ?? 0} validated
                </dd>
                <p className="text-muted-foreground mt-1 text-xs">
                  {findings?.nonConclusiveCount ?? 0} non-conclusive (blocked/inconclusive/
                  unlabeled). Verified means independently confirmed; validated is deterministic
                  checking only.
                </p>
              </div>
              <div className="rounded-md border p-3">
                <dt className="text-muted-foreground text-xs">Coverage receipts (measured)</dt>
                <dd className="mt-1 text-sm font-medium">
                  {coverage?.receiptsTotal ?? 0} recorded · {coverage?.engineDeclaredReceipts ?? 0}{" "}
                  engine-declared · {coverage?.connectorReceipts ?? 0} connector
                </dd>
                <p className="text-muted-foreground mt-1 text-xs">
                  Engine-declared entries are the engine&apos;s own assertions, not measured
                  outcomes.
                </p>
              </div>
              <div className="rounded-md border p-3">
                <dt className="text-muted-foreground text-xs">Assessed share (heuristic)</dt>
                <dd className="mt-1 text-sm font-medium">
                  {quality.estimates?.assessedReceiptRatio?.value == null
                    ? "Not assessable"
                    : `${Math.round(quality.estimates.assessedReceiptRatio.value * 100)}%`}
                </dd>
                <p className="text-muted-foreground mt-1 text-xs">
                  {quality.estimates?.assessedReceiptRatio?.basis ??
                    "Ratio of completed receipts — heuristic only."}
                </p>
              </div>
            </dl>
          </Card>
        )
      })()}

      {(scan.integrity.coverage.length > 0 || reviewProfile.model) && (
        <Card className="mb-6 p-4" aria-labelledby="review-profile-heading">
          <div>
            <h2 id="review-profile-heading" className="font-semibold">
              Review details
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              AI assistance can support analysis. Retained scanner receipts and independent
              verification determine the proof state shown by LyraShield.
            </p>
          </div>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border p-3">
              <dt className="text-muted-foreground text-xs">Analysis path</dt>
              <dd className="mt-1 text-sm font-medium">
                {reviewProfile.model ? "AI-assisted review" : "Deterministic scanners"}
              </dd>
              <p className="text-muted-foreground mt-1 text-xs">
                Exact execution provenance is retained in the sealed scan manifest.
              </p>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-muted-foreground text-xs">Vibe Security 50</dt>
              <dd className="mt-1 text-sm font-medium">
                {controlCoverage.length > 0
                  ? `${controlCoverage.length} controls recorded`
                  : "Pending"}
              </dd>
              <p className="text-muted-foreground mt-1 text-xs">
                {controlCoverage.length === 0
                  ? "No checklist receipt recorded"
                  : `${controlOutcomeCounts.DETECTED ?? 0} with findings · ${controlOutcomeCounts.EVIDENCE_REQUIRED ?? 0} need evidence`}
              </p>
            </div>
          </dl>
        </Card>
      )}

      {(scan.integrity.scopedCoverage ||
        scan.integrity.threatModel ||
        scan.integrity.attachments ||
        (scan.integrity.ingestionWarnings?.length ?? 0) > 0) && (
        <Card className="mb-6 p-4" aria-labelledby="declared-coverage-heading">
          <h2 id="declared-coverage-heading" className="font-semibold">
            Declared coverage and inputs
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Engine-declared evidence recorded in the sealed manifest. These are the engine&apos;s
            own assertions — not independent verification.
          </p>

          {(() => {
            const scoped = scan.integrity.scopedCoverage as
              | {
                  entries?: Array<{ id?: string; subject?: string; outcome?: string }>
                  gaps?: Array<{ kind?: string; subject?: string; detail?: string }>
                  completeness?: { complete?: boolean; caveats?: string[] }
                }
              | null
              | undefined
            const entries = Array.isArray(scoped?.entries) ? scoped.entries : []
            const gaps = Array.isArray(scoped?.gaps) ? scoped.gaps : []
            const caveats = Array.isArray(scoped?.completeness?.caveats)
              ? scoped.completeness.caveats
              : []
            return (
              <>
                {(entries.length > 0 || gaps.length > 0 || caveats.length > 0) && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Requested vs achieved coverage
                      {entries.length > 0
                        ? ` — ${entries.length} declared item${entries.length === 1 ? "" : "s"}`
                        : ""}
                      {gaps.length > 0
                        ? `, ${gaps.length} declared gap${gaps.length === 1 ? "" : "s"}`
                        : ""}
                    </summary>
                    <div className="mt-2 space-y-2 text-sm">
                      {entries.length > 0 && (
                        <ul className="space-y-1">
                          {entries.slice(0, 25).map((entry, index) => (
                            <li
                              key={entry.id ?? index}
                              className="flex flex-wrap items-center gap-2"
                            >
                              <Badge
                                variant={entry.outcome === "needs_follow_up" ? "warning" : "muted"}
                              >
                                {entry.outcome?.replaceAll("_", " ") ?? "declared"}
                              </Badge>
                              <span className="text-muted-foreground wrap-break-word">
                                {entry.subject ?? entry.id}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {gaps.length > 0 && (
                        <ul className="space-y-1">
                          {gaps.slice(0, 25).map((gap, index) => (
                            <li key={index} className="flex flex-wrap items-center gap-2">
                              <Badge variant="warning">gap</Badge>
                              <span className="text-muted-foreground wrap-break-word">
                                {gap.subject ? `${gap.subject}: ` : ""}
                                {gap.detail ?? gap.kind}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {caveats.slice(0, 10).map((caveat, index) => (
                        <p key={index} className="text-xs text-amber-600">
                          {caveat}
                        </p>
                      ))}
                    </div>
                  </details>
                )}
              </>
            )
          })()}

          {scan.integrity.threatModel && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium">
                Threat-model assumptions — {scan.integrity.threatModel.modelCount} model
                {scan.integrity.threatModel.modelCount === 1 ? "" : "s"} declared
              </summary>
              <div className="mt-2 space-y-2 text-sm">
                {(scan.integrity.threatModel.entries ?? []).map((entry, index) => (
                  <div key={index} className="rounded-md border p-2">
                    <p className="text-xs font-medium">{entry.target}</p>
                    <p className="text-muted-foreground mt-1 text-xs wrap-break-word">
                      {entry.preview}
                    </p>
                  </div>
                ))}
                <p className="text-muted-foreground text-xs">
                  Sealed artifact checksum:{" "}
                  <code className="font-mono">
                    {scan.integrity.threatModel.checksum.slice(0, 16)}…
                  </code>
                </p>
              </div>
            </details>
          )}

          {scan.integrity.attachments && (
            <p className="text-muted-foreground mt-3 text-sm">
              {scan.integrity.attachments.count} supporting file
              {scan.integrity.attachments.count === 1 ? "" : "s"} staged read-only and verified
              against recorded checksums (manifest{" "}
              <code className="font-mono">
                {scan.integrity.attachments.manifestChecksum.slice(0, 12)}…
              </code>
              ).
            </p>
          )}

          {(scan.integrity.ingestionWarnings?.length ?? 0) > 0 && (
            <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-sm font-medium text-amber-700">
                {scan.integrity.ingestionWarnings!.length} evidence ingestion issue
                {scan.integrity.ingestionWarnings!.length === 1 ? "" : "s"} recorded
              </p>
              <ul className="text-muted-foreground mt-1 list-inside list-disc text-xs">
                {scan.integrity.ingestionWarnings!.slice(0, 10).map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
    </>
  )
}

function renderUrlExecutionLine(execution: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    WEB_APP_SAFE: "Surface Review",
    WEB_APP_STANDARD: "Expanded Surface Review",
    WEB_APP_DEEP: "Behavioral Surface Review",
    API_SAFE: "Endpoint Review",
    API_STANDARD: "Contract Review",
    API_DEEP: "Contract Behavior Review",
  }
  const name = labels[String(execution.profile)] ?? String(execution.profile ?? "URL scan")
  const methods = Array.isArray(execution.methods) ? execution.methods.join(", ") : ""
  const parts: string[] = []
  if (typeof execution.documentCount === "number" && execution.documentCount > 0) {
    parts.push(`${execution.documentCount} pages`)
  }
  if (typeof execution.assetCount === "number" && execution.assetCount > 0) {
    parts.push(`${execution.assetCount} assets`)
  }
  if (typeof execution.operationCount === "number" && execution.operationCount > 0) {
    parts.push(`${execution.operationCount} operations`)
  }
  if (typeof execution.methodProbeCount === "number" && execution.methodProbeCount > 0) {
    parts.push(`${execution.methodProbeCount} method probes`)
  }
  if (typeof execution.originProbeCount === "number" && execution.originProbeCount > 0) {
    parts.push(`${execution.originProbeCount} origin probes`)
  }
  const scope = parts.length > 0 ? ` · ${parts.join(" · ")}` : ""
  return `${name}${scope} · ${methods}`
}
