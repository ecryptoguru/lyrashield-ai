"use client"

import { useState, useCallback, useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useLaunchReadinessWebMcp } from "./launch-readiness-webmcp"
import {
  Rocket,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Info,
} from "lucide-react"
import { Card, Badge, Button, Spinner, EmptyState } from "@lyrashield/ui"
import { PageHeader } from "@/components/page-header"
import { z } from "zod"
import { apiGet } from "@/lib/api-client"
import { ScoreGauge } from "@/components/security-visuals"
import {
  gateReasonSentence,
  parseReleaseReference,
  type ReleaseCheckResult,
} from "@/lib/launch-readiness"

export interface LaunchReadinessReport {
  state: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"
  verdict: "NOT_EVALUATED" | "INCONCLUSIVE" | "GO" | "GO_WITH_CONDITIONS" | "NO_GO"
  score: number | null
  triageScore: number | null
  summary: string
  blockingFindings: number
  totalFindings: number
  verifiedFindings: number
  bySeverity: Record<string, number>
  conditions: string[]
  recommendations: string[]
}

const identitySchema = z.object({
  kind: z.enum(["COMMIT", "ARTIFACT_DIGEST"]),
  value: z.string(),
})

const releaseCheckSchema = z
  .object({
    targetId: z.string(),
    targetName: z.string().nullable(),
    requested: identitySchema.nullable(),
    assessed: identitySchema.nullable(),
    match: z.enum(["match", "mismatch", "cannot_confirm"]),
    historicalState: z.enum(["READY", "NOT_READY", "INSUFFICIENT_EVIDENCE"]).nullable(),
    state: z.enum(["READY", "NOT_READY", "INSUFFICIENT_EVIDENCE"]),
    applicable: z.boolean(),
    blockingFindings: z.number(),
    reasons: z.array(z.object({ code: z.string(), message: z.string() })),
  })
  .nullable()

const launchReadinessReportSchema = z
  .object({
    state: z.enum(["READY", "NOT_READY", "INSUFFICIENT_EVIDENCE"]),
    verdict: z.enum(["NOT_EVALUATED", "INCONCLUSIVE", "GO", "GO_WITH_CONDITIONS", "NO_GO"]),
    score: z.number().nullable(),
    triageScore: z.number().nullable(),
    summary: z.string(),
    blockingFindings: z.number(),
    totalFindings: z.number(),
    verifiedFindings: z.number(),
    bySeverity: z.record(z.string(), z.number()),
    conditions: z.array(z.string()),
    recommendations: z.array(z.string()),
    releaseCheck: releaseCheckSchema.optional(),
  })
  .passthrough()

const VERDICT_CONFIG = {
  // A completed run that evaluated nothing. Deliberately not styled as a pass:
  // zero findings from zero coverage is the absence of evidence.
  INCONCLUSIVE: {
    icon: ShieldAlert,
    label: "Inconclusive — Nothing Checked",
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    badgeVariant: "warning" as const,
  },
  NOT_EVALUATED: {
    icon: ShieldAlert,
    label: "Not Evaluated",
    color: "text-muted-foreground",
    bg: "bg-muted/30",
    border: "border-border",
    badgeVariant: "muted" as const,
  },
  GO: {
    icon: ShieldCheck,
    label: "Ready to Launch",
    color: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    badgeVariant: "success" as const,
  },
  GO_WITH_CONDITIONS: {
    icon: ShieldAlert,
    label: "Launch with Conditions",
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    badgeVariant: "warning" as const,
  },
  NO_GO: {
    icon: ShieldX,
    label: "Do Not Launch",
    color: "text-destructive",
    bg: "bg-destructive/10",
    border: "border-destructive/20",
    badgeVariant: "danger" as const,
  },
}

function SeverityBreakdown({ bySeverity }: { bySeverity: Record<string, number> }) {
  const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
  const colors: Record<string, string> = {
    CRITICAL: "bg-destructive",
    HIGH: "bg-orange-500",
    MEDIUM: "bg-amber-500",
    LOW: "bg-sky-500",
    INFO: "bg-muted-foreground",
  }
  const maxCount = Math.max(1, ...severities.map((s) => bySeverity[s] ?? 0))

  return (
    <div className="space-y-2">
      {severities.map((sev) => {
        const count = bySeverity[sev] ?? 0
        if (count === 0) return null
        return (
          <div key={sev} className="flex items-center gap-3">
            <div className={`h-2 w-2 rounded-full ${colors[sev]}`} aria-hidden="true" />
            <span className="w-20 text-sm font-medium">{sev}</span>
            <div className="bg-muted h-6 flex-1 overflow-hidden rounded-md">
              <div
                className={`h-full ${colors[sev]} flex items-center justify-end px-2`}
                style={{ width: `${Math.min(100, (count / maxCount) * 100)}%` }}
              >
                <span className="text-xs font-medium text-white">{count}</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

const HISTORICAL_STATE_LABEL: Record<string, string> = {
  READY: "Ready to launch",
  NOT_READY: "Not ready",
  INSUFFICIENT_EVIDENCE: "Not enough evidence",
}

function identityText(identity: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string } | null) {
  if (!identity) return null
  return identity.kind === "COMMIT" ? `commit ${identity.value}` : `artifact ${identity.value}`
}

export function LaunchReadinessClient({
  workspaceId,
  initialReport,
  targets,
  initialTargetId,
  initialReleaseCheck,
  initialCheckError,
  checkNeedsTarget,
}: {
  workspaceId: string
  initialReport: LaunchReadinessReport
  targets: { targetId: string; targetName: string }[]
  initialTargetId: string
  initialReleaseCheck: ReleaseCheckResult | null
  initialCheckError: string | null
  checkNeedsTarget: boolean
}) {
  const router = useRouter()
  const [report, setReport] = useState<LaunchReadinessReport>(initialReport)
  const [releaseCheck, setReleaseCheck] = useState<ReleaseCheckResult | null>(initialReleaseCheck)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedTargetId, setSelectedTargetId] = useState(initialTargetId)
  const [releaseRef, setReleaseRef] = useState("")
  const [formError, setFormError] = useState<string | null>(initialCheckError)

  useLaunchReadinessWebMcp({ workspaceId, onReport: setReport })

  const loadReport = useCallback(
    (signal?: AbortSignal, options?: { silent?: boolean }) => {
      const silent = options?.silent === true
      if (!silent) setLoading(true)
      // Carry the URL's check state so a refresh re-runs the same check rather
      // than silently dropping back to the informational view.
      const params = new URLSearchParams(window.location.search)
      params.set("workspaceId", workspaceId)
      apiGet<LaunchReadinessReport & { releaseCheck?: ReleaseCheckResult | null }>(
        `/api/launch-readiness?${params.toString()}`,
        { signal, schema: launchReadinessReportSchema }
      )
        .then((data) => {
          setReport(data)
          setReleaseCheck(data.releaseCheck ?? null)
          setError(null)
        })
        .catch(() => {
          // A silent background refresh must not replace a perfectly good report
          // with an error screen; the explicit Refresh action still surfaces it.
          if (!silent) {
            setError("Failed to load launch readiness report. Please try again.")
            setReleaseCheck(null)
          }
        })
        .finally(() => {
          if (!silent) setLoading(false)
        })
    },
    [workspaceId]
  )

  // This page does not poll (readiness only moves when a scan finishes), so it
  // can otherwise show an SSR snapshot indefinitely. Revalidate quietly when the
  // tab regains focus — the API serves the report with no-store, and `silent`
  // keeps the current report on screen while it refreshes.
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) loadReport(undefined, { silent: true })
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [loadReport])

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20" aria-busy="true">
        <Spinner className="h-8 w-8" />
        <p className="text-muted-foreground text-sm">Loading launch readiness report...</p>
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Could not load report"
        description={error}
        action={
          <Button variant="outline" size="sm" onClick={() => loadReport()}>
            Try again
          </Button>
        }
      />
    )
  }

  const config = VERDICT_CONFIG[report.verdict] ?? VERDICT_CONFIG.NO_GO
  const VerdictIcon = config.icon

  function submitCheck(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    const ref = releaseRef.trim()
    const parsed = ref ? parseReleaseReference(ref) : null
    if (ref && !parsed) {
      setFormError("Enter a full 40-character commit SHA or a sha256: artifact digest.")
      return
    }
    if (ref && !selectedTargetId) {
      setFormError("Choose the target this release belongs to.")
      return
    }
    const params = new URLSearchParams()
    if (selectedTargetId) params.set("targetId", selectedTargetId)
    if (parsed?.kind === "COMMIT") params.set("commit", parsed.value)
    if (parsed?.kind === "ARTIFACT_DIGEST") params.set("artifactDigest", parsed.value)
    const query = params.toString()
    router.push(`/dashboard/launch-readiness${query ? `?${query}` : ""}`)
  }

  function clearCheck() {
    setReleaseRef("")
    setFormError(null)
    router.push("/dashboard/launch-readiness")
  }

  const checkActive = Boolean(releaseCheck?.requested) || Boolean(initialCheckError)

  return (
    <div className="space-y-6">
      <PageHeader title="Launch Readiness" icon={Rocket} />

      {/* Release check — an identity-checked read, not a deployment gate */}
      <Card className="p-5">
        <form onSubmit={submitCheck} noValidate>
          <label htmlFor="release-check-reference" className="text-sm font-medium">
            Check a specific release (optional)
          </label>
          <p className="text-muted-foreground mt-1 text-sm">
            Choose a target and paste the full commit SHA or artifact digest for the release you
            want to check.
          </p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <label htmlFor="release-check-target" className="sr-only">
              Target
            </label>
            <select
              id="release-check-target"
              value={selectedTargetId}
              onChange={(event) => setSelectedTargetId(event.target.value)}
              className="border-border bg-background text-foreground rounded-md border px-3 py-2 text-sm sm:w-56"
            >
              <option value="">Select a target</option>
              {targets.map((target) => (
                <option key={target.targetId} value={target.targetId}>
                  {target.targetName}
                </option>
              ))}
            </select>
            <input
              id="release-check-reference"
              type="text"
              value={releaseRef}
              onChange={(event) => setReleaseRef(event.target.value)}
              placeholder="Commit SHA or sha256: artifact digest"
              spellCheck={false}
              autoComplete="off"
              className="border-border bg-background text-foreground min-w-0 flex-1 rounded-md border px-3 py-2 font-mono text-sm"
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" className="h-9">
                Check release
              </Button>
              {checkActive && (
                <Button type="button" variant="outline" size="sm" className="h-9" onClick={clearCheck}>
                  Clear
                </Button>
              )}
            </div>
          </div>
          {formError && (
            <p role="alert" className="text-destructive mt-2 text-sm">
              {formError}
            </p>
          )}
        </form>
        {!checkActive && !checkNeedsTarget && (
          <p className="text-muted-foreground mt-3 text-xs">
            Without a release reference, this view is informational. It shows what the latest
            assessment covers; it does not check a specific release.
          </p>
        )}
        {checkNeedsTarget && (
          <p className="text-muted-foreground mt-3 text-sm" role="status">
            Choose the target this release belongs to, then check again.
          </p>
        )}
      </Card>

      {/* Release check result — match state, identities, and applicability */}
      {releaseCheck?.requested && (
        <Card
          className={`p-5 ${
            releaseCheck.match === "match"
              ? "border-emerald-500/20 bg-emerald-500/5"
              : releaseCheck.match === "mismatch"
                ? "border-destructive/20 bg-destructive/5"
                : "border-border bg-muted/30"
          }`}
        >
          <div role="status" aria-live="polite">
            <h3 className="font-semibold">
              {releaseCheck.match === "match"
                ? "Release reference matches this assessment."
                : releaseCheck.match === "mismatch"
                  ? "This assessment covers a different release."
                  : "Cannot confirm this release from the retained assessment."}
            </h3>
            <dl className="text-muted-foreground mt-3 space-y-1 text-sm">
              <div className="flex flex-wrap gap-x-2">
                <dt className="font-medium">Target:</dt>
                <dd>{releaseCheck.targetName ?? "Unknown target"}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="font-medium">Requested:</dt>
                <dd>
                  <code className="break-all">{identityText(releaseCheck.requested)}</code>
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="font-medium">Assessed:</dt>
                <dd>
                  {releaseCheck.assessed ? (
                    <code className="break-all">{identityText(releaseCheck.assessed)}</code>
                  ) : (
                    "No release identity is retained in this assessment."
                  )}
                </dd>
              </div>
              {releaseCheck.historicalState && (
                <div className="flex flex-wrap gap-x-2">
                  <dt className="font-medium">Historical verdict:</dt>
                  <dd>
                    {HISTORICAL_STATE_LABEL[releaseCheck.historicalState] ??
                      releaseCheck.historicalState}
                    {" · effective now: "}
                    {HISTORICAL_STATE_LABEL[releaseCheck.state] ?? releaseCheck.state}
                  </dd>
                </div>
              )}
            </dl>
            {releaseCheck.reasons.length > 0 && (
              <ul className="mt-3 space-y-1">
                {releaseCheck.reasons.map((reason) => (
                  <li key={reason.code} className="text-foreground/80 text-sm">
                    {gateReasonSentence(reason)}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              {releaseCheck.blockingFindings > 0 && (
                <Link
                  href={`/dashboard/findings?target=${encodeURIComponent(releaseCheck.targetId)}`}
                  className="text-accent font-medium underline underline-offset-4"
                >
                  Inspect blocking findings
                </Link>
              )}
              {releaseCheck.reasons.some((r) => r.code === "NEWER_ASSESSMENT_ATTEMPT") && (
                <Link
                  href={`/dashboard/scans?target=${encodeURIComponent(releaseCheck.targetId)}`}
                  className="text-accent font-medium underline underline-offset-4"
                >
                  Inspect the in-progress assessment
                </Link>
              )}
              {(releaseCheck.match !== "match" || !releaseCheck.applicable) && (
                <Link
                  href={`/dashboard/scans?new=1&target=${encodeURIComponent(releaseCheck.targetId)}`}
                  className="text-accent font-medium underline underline-offset-4"
                >
                  Open scan creation
                </Link>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Verdict Card */}
      <Card className={`p-6 ${config.bg} ${config.border}`}>
        <div className="flex flex-col items-center gap-6 sm:flex-row">
          <ScoreGauge score={report.triageScore} />
          <div className="flex-1 text-center sm:text-left">
            <div className="mb-2 flex items-center justify-center gap-2 sm:justify-start">
              <VerdictIcon className={`h-7 w-7 ${config.color}`} aria-hidden="true" />
              <h2 className={`text-2xl font-bold ${config.color}`}>{config.label}</h2>
            </div>
            <p className="text-muted-foreground mb-4 text-sm">{report.summary}</p>
            <div className="flex flex-wrap justify-center gap-2 sm:justify-start">
              <Badge variant={config.badgeVariant}>
                {report.triageScore === null
                  ? "Triage score pending"
                  : `Triage score: ${report.triageScore}/100`}
              </Badge>
              <Badge variant="muted">{report.totalFindings} total findings</Badge>
              <Badge variant="muted">{report.blockingFindings} blocking</Badge>
              <Badge variant="muted">{report.verifiedFindings} verified</Badge>
            </div>
          </div>
        </div>
      </Card>

      {/* Conditions & Recommendations */}
      <div className="grid gap-4 md:grid-cols-2">
        {report.conditions.length > 0 && (
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden="true" />
              <h3 className="font-semibold">Conditions</h3>
            </div>
            <ul className="space-y-2">
              {report.conditions.map((cond, i) => (
                <li key={i} className="text-foreground/80 flex items-start gap-2 text-sm">
                  <span className="mt-0.5 text-amber-500" aria-hidden="true">
                    •
                  </span>
                  {cond}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {report.recommendations.length > 0 && (
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-sky-500" aria-hidden="true" />
              <h3 className="font-semibold">Recommendations</h3>
            </div>
            <ul className="space-y-2">
              {report.recommendations.map((rec, i) => (
                <li key={i} className="text-foreground/80 flex items-start gap-2 text-sm">
                  <span className="mt-0.5 text-sky-500" aria-hidden="true">
                    •
                  </span>
                  {rec}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      {/* Severity Breakdown */}
      {report.totalFindings > 0 && (
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <Info className="text-muted-foreground h-5 w-5" aria-hidden="true" />
            <h3 className="font-semibold">Findings by Severity</h3>
          </div>
          <SeverityBreakdown bySeverity={report.bySeverity} />
        </Card>
      )}

      {/* Completed scope */}
      {report.verdict === "GO" && report.totalFindings === 0 && (
        <Card className="p-6 text-center">
          <CheckCircle2 className="mx-auto mb-3 h-12 w-12 text-emerald-500" aria-hidden="true" />
          <h3 className="mb-1 text-lg font-semibold">No blocking findings in completed scope</h3>
          <p className="text-muted-foreground text-sm">
            No findings were reported within completed scan coverage. Review the retained coverage
            and limitations before making your launch decision.
          </p>
        </Card>
      )}
    </div>
  )
}
