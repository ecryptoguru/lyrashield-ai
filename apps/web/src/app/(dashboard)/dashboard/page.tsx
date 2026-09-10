import type { Metadata } from "next"
import Link from "next/link"
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Bug,
  Crosshair,
  LoaderCircle,
  Plus,
  Play,
  ShieldCheck,
  Wrench,
} from "lucide-react"
import { Badge, Card, EmptyState, buttonVariants } from "@lyrashield/ui"
import {
  MetricCard,
  RemediationBars,
  ScoreGauge,
  ScoreTrend,
  SeverityDonut,
} from "@/components/security-visuals"
import { formatDate, formatDateTime } from "@/lib/date-format"
import { HOME_LABEL } from "@/lib/terminology"
import {
  getCachedSession,
  getCachedWorkspaceId,
  getCachedWorkspaces,
  getCachedDashboardOverview,
} from "@/lib/cache"
import { TrustCommandCenter } from "@/components/trust-command-center"
import { deriveHomeDecision } from "@/lib/home-next-action"
import { projectGateReadinessReport } from "@/lib/launch-readiness"
import { getGateReadinessTargets } from "@/lib/launch-readiness-server"
import { getScanPresentation, isActiveScan } from "@/lib/scan-presentation"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { presentOperationFailure } from "@/lib/operation-failure"

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Workspace overview, recent scans, findings, and launch readiness.",
  openGraph: {
    title: "Dashboard | LyraShield AI",
    description: "Workspace overview, recent scans, findings, and launch readiness.",
    type: "website",
    siteName: "LyraShield AI",
  },
}

export default async function DashboardPage() {
  const session = await getCachedSession()
  if (!session) return null

  const [workspaces, workspaceId] = await Promise.all([
    getCachedWorkspaces(session.userId),
    getCachedWorkspaceId(session.userId),
  ])

  if (!workspaceId || workspaces.length === 0) {
    return (
      <div>
        <PageHeader title={HOME_LABEL} />
        <NoWorkspaceState
          icon={ShieldCheck}
          description="Create your first workspace to start scanning your apps."
        />
      </div>
    )
  }

  const activeWorkspace = workspaces.find((workspace) => workspace.id === workspaceId)

  // One coherent read model: every headline below describes the same evidence
  // scope instead of independently-selected workspace aggregates.
  const [overview, gateTargets] = await Promise.all([
    getCachedDashboardOverview(workspaceId),
    // Release decisions use an uncached applicability read even though the
    // surrounding dashboard aggregates are cached.
    getGateReadinessTargets(workspaceId),
  ])
  const {
    targets,
    openIssues,
    openIssuesBySeverity,
    findingGroups,
    scoreHistory,
    reportCount,
    project,
    latestRun,
    lastEvaluatedAssessment,
    recentRuns,
    remediation,
  } = overview

  const targetCount = targets.total
  const readiness = projectGateReadinessReport(
    findingGroups.map((group) => ({
      severity: group.severity,
      status: group.status,
      verified: group.verified,
      count: group.count,
    })),
    gateTargets
  )

  // W1-02/W1-03: one canonical decision drives BOTH the header CTA and the
  // next-action panel, consumes the uncached gate result, and leads with an
  // active scan's progress instead of recommending a duplicate.
  const decision = deriveHomeDecision({
    targets,
    lastEvaluatedAssessment,
    reportCount,
    openIssues,
    gateTargets: gateTargets.map((target) => ({
      targetId: target.targetId,
      targetName: target.targetName,
      state: target.state,
      applicable: target.applicable,
      blockingFindings: target.blockingFindings,
      reasons: target.reasons,
    })),
    activeScan: overview.activeScan,
  })

  const latestScore =
    lastEvaluatedAssessment &&
    lastEvaluatedAssessment.score !== null &&
    lastEvaluatedAssessment.grade !== null
      ? {
          score: lastEvaluatedAssessment.score,
          grade: lastEvaluatedAssessment.grade,
          targetName: lastEvaluatedAssessment.targetName,
          completedAtLabel: formatDate(lastEvaluatedAssessment.completedAt),
        }
      : null

  // The trend plots only snapshots bound to scans with usable coverage — the
  // read model already excludes scores from runs that evaluated nothing. The
  // posture header demotes the score entirely while the canonical verdict is
  // inconclusive: a green 100 beside "Inconclusive" reads as an all-clear the
  // evidence does not support.
  const trend = [...scoreHistory]
    .reverse()
    .map((snapshot) => ({ label: formatDate(snapshot.computedAt), score: snapshot.score }))

  const coverageLabel =
    targetCount === 0
      ? "No targets yet"
      : `${targets.assessed}/${targetCount} assessed` +
        (targets.partiallyAssessed > 0 ? ` · ${targets.partiallyAssessed} partial` : "") +
        (targets.expiredAssessments > 0 ? ` · ${targets.expiredAssessments} expired` : "")

  // Latest-run banner: only when the newest run needs the user's attention.
  const latestRunAlert =
    latestRun &&
    (isActiveScan(latestRun.status) ||
      latestRun.userSafeFailure ||
      latestRun.coverageState === "NONE")
      ? latestRun
      : null

  const primaryAction = decision.primaryAction
  const primaryIcon = primaryAction.href.startsWith("/dashboard/targets") ? "plus" : "play"

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      {/* 1 — workspace label and the one primary CTA from the canonical decision */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-primary text-xs font-semibold tracking-[0.15em] uppercase">
            {activeWorkspace?.name ?? "Active workspace"}
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-[-0.035em] sm:text-4xl">
            What needs your attention?
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Start with the next decision, then use the evidence below when you need detail.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          <Link href={primaryAction.href} className={buttonVariants()}>
            {primaryIcon === "plus" ? (
              <Plus className="size-4" aria-hidden="true" />
            ) : (
              <Play className="size-4" aria-hidden="true" />
            )}
            {primaryAction.label}
          </Link>
        </div>
      </header>

      {/* One contextual next action — same decision model as the header CTA. */}
      {decision.action && (
        <section
          className="border-primary/30 bg-primary/[0.04] rounded-xl border p-5 sm:p-6"
          aria-labelledby="home-next-action"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                {decision.action.eyebrow}
              </p>
              <h2 id="home-next-action" className="mt-1 text-xl font-bold tracking-tight">
                {decision.action.title}
              </h2>
              <p className="text-muted-foreground mt-1.5 max-w-2xl text-sm">
                {decision.action.description}
              </p>
            </div>
            <Link
              href={decision.action.href}
              className={`${buttonVariants({ className: "shrink-0" })} min-h-11`}
            >
              {decision.action.cta}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </section>
      )}

      {/* 2 — current posture: gate state and evidence scope before any score (W1-04) */}
      <TrustCommandCenter
        productName={project?.name ?? activeWorkspace?.name ?? "Workspace"}
        mode={latestRun?.mode ?? null}
        trustPlanData={project?.trustPlan}
        gate={{
          state: readiness.state ?? "INSUFFICIENT_EVIDENCE",
          coverageLabel,
        }}
        latestScore={readiness.state === "READY" ? latestScore : null}
      />

      {/* 3 — latest run warning/progress when it needs attention */}
      {latestRunAlert && <LatestRunAlert run={latestRunAlert} />}

      {/* 4 — three compact metrics: blockers, freshness/coverage, activity (W1-05).
          Score, severity mix, verification counts, and trends remain reachable in
          the secondary analytics sections below. */}
      <section className="grid gap-4 sm:grid-cols-3" aria-label="Workspace metrics">
        <MetricCard
          label="Actionable blockers"
          value={openIssues.critical + openIssues.high}
          detail={`${openIssuesBySeverity.CRITICAL ?? 0} critical · ${openIssuesBySeverity.HIGH ?? 0} high · workspace-wide`}
          icon={Bug}
        />
        <MetricCard
          label="Assessment coverage"
          value={targetCount === 0 ? "—" : `${targets.assessed}/${targetCount}`}
          detail={coverageLabel}
          icon={Crosshair}
        />
        <MetricCard
          label="Current activity"
          value={
            overview.activeScan
              ? "Scan running"
              : latestRun
                ? getScanPresentation(latestRun.status, {}).label
                : "—"
          }
          detail={
            overview.activeScan
              ? `${overview.activeScan.targetName ?? "Workspace"} scan in progress`
              : latestRun
                ? `Last run ${formatDateTime(latestRun.createdAt)}`
                : "No scan activity yet"
          }
          icon={Activity}
        />
      </section>

      {/* 5 — recent activity */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b px-5 py-4 sm:px-6">
          <div>
            <h2 className="font-semibold">Recent activity</h2>
            <p className="text-muted-foreground mt-1 text-xs">Your most recent scans.</p>
          </div>
          <Link
            href="/dashboard/scans"
            className="text-primary flex min-h-11 items-center gap-1 text-sm font-medium"
          >
            View all <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        {recentRuns.length > 0 ? (
          <div className="divide-y">
            {recentRuns.map((run) => {
              const presentation = getScanPresentation(run.status, {})
              return (
                <Link
                  key={run.id}
                  href={`/dashboard/scans/${run.id}`}
                  className="hover:bg-accent/60 flex min-h-16 items-center gap-3 px-5 py-3 transition-colors sm:px-6"
                >
                  <span className="bg-primary/8 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
                    <Activity className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {run.targetName ?? "Workspace scan"}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {formatDateTime(run.createdAt)} · {run.findingCount} retained finding
                      {run.findingCount === 1 ? "" : "s"} on record
                    </span>
                  </span>
                  <Badge variant={presentation.badgeVariant}>{presentation.label}</Badge>
                </Link>
              )
            })}
          </div>
        ) : (
          <div className="px-5 py-6 sm:px-6">
            <EmptyState
              icon={Activity}
              title="No scan activity yet"
              description={
                targetCount === 0
                  ? "Add a target to begin your first review."
                  : "Run your first review to see activity here."
              }
              action={
                <Link
                  href={primaryAction.href}
                  className={buttonVariants({ variant: "secondary", size: "sm" })}
                >
                  {primaryIcon === "plus" ? (
                    <Plus className="size-4" aria-hidden="true" />
                  ) : (
                    <Play className="size-4" aria-hidden="true" />
                  )}
                  {primaryAction.label}
                </Link>
              }
            />
          </div>
        )}
      </Card>

      {/* 6 — secondary analytics and remediation details (on demand) */}
      <section className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Card className="p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">Risk posture</h2>
              <p className="text-muted-foreground mt-1 text-xs">
                {latestScore && readiness.state === "READY"
                  ? `Score from the ${latestScore.completedAtLabel} review of ${latestScore.targetName}, with recent evaluated snapshots.`
                  : "No launch-ready verdict yet. Scores appear when every active target's gate is ready."}
              </p>
            </div>
            <Badge
              variant={
                latestScore && readiness.state === "READY"
                  ? latestScore.score >= 80
                    ? "success"
                    : "warning"
                  : "muted"
              }
            >
              {latestScore && readiness.state === "READY" ? "Evaluated" : "Not launch-ready"}
            </Badge>
          </div>
          <div className="grid items-center gap-6 md:grid-cols-[auto_1fr]">
            <ScoreGauge
              score={readiness.state === "READY" ? (latestScore?.score ?? null) : null}
              grade={readiness.state === "READY" ? (latestScore?.grade ?? null) : null}
            />
            <ScoreTrend points={trend} />
          </div>
        </Card>

        <Card className="p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">Retained finding mix</h2>
              <p className="text-muted-foreground mt-1 text-xs">
                All retained findings grouped by severity, workspace-wide.
              </p>
            </div>
            <Badge variant="muted">{openIssues.independentlyVerified} independently verified</Badge>
          </div>
          <SeverityDonut values={openIssuesBySeverity} />
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_1.35fr]">
        <Card className="p-5 sm:p-6">
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold">Remediation flow</h2>
              <p className="text-muted-foreground mt-1 text-xs">
                Current finding movement from review through closure.
              </p>
            </div>
            <Wrench className="text-primary size-5" aria-hidden="true" />
          </div>
          <RemediationBars
            rows={[
              {
                label: "Open",
                value: Math.max(
                  0,
                  openIssues.total - remediation.inProgress - remediation.riskAccepted
                ),
                tone: "warning",
              },
              { label: "In remediation", value: remediation.inProgress, tone: "primary" },
              { label: "Fixed", value: remediation.fixed, tone: "success" },
              { label: "Risk accepted", value: remediation.riskAccepted },
            ]}
          />
        </Card>

        <Card className="p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">Launch verdict</h2>
              <p className="text-muted-foreground mt-1 text-xs">
                Derived from retained evidence across every active target.
              </p>
            </div>
            <Link
              href="/dashboard/launch-readiness"
              className="text-primary flex min-h-11 items-center gap-1 text-sm font-medium"
            >
              Details <ArrowUpRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
          <div
            className={`border-l-2 p-4 ${
              readiness.verdict === "GO"
                ? "border-success bg-success/10"
                : readiness.verdict === "NO_GO"
                  ? "border-destructive bg-destructive/10"
                  : "border-warning bg-warning/10"
            }`}
          >
            <p className="font-semibold">
              {readiness.verdict === "GO"
                ? "Ready to launch"
                : readiness.verdict === "INCONCLUSIVE"
                  ? "Inconclusive: nothing was checked"
                  : readiness.verdict === "NOT_EVALUATED"
                    ? "Needs evidence"
                    : readiness.verdict === "GO_WITH_CONDITIONS"
                      ? "Ready with conditions"
                      : "Needs action"}
            </p>
            <ul className="text-muted-foreground mt-2 space-y-1 text-sm">
              {(readiness.conditions.length > 0
                ? readiness.conditions
                : ["Current scan evidence has no unresolved launch blockers."]
              )
                .slice(0, 3)
                .map((condition) => (
                  <li key={condition}>{condition}</li>
                ))}
            </ul>
            <p className="text-muted-foreground mt-2 text-xs">
              Absence of findings is not independent verification or a security guarantee.
            </p>
          </div>
        </Card>
      </section>
    </div>
  )
}

function LatestRunAlert({
  run,
}: {
  run: NonNullable<Awaited<ReturnType<typeof getCachedDashboardOverview>>["latestRun"]>
}) {
  const active = isActiveScan(run.status)
  const presentation = getScanPresentation(run.status, {})
  // W1-07: failures present cause, effect, and recovery from structured codes.
  const failure =
    !active && (run.userSafeFailure || run.coverageState === "NONE")
      ? presentOperationFailure(
          run.userSafeFailure
            ? run.status === "STOPPED_BUDGET"
              ? "NO_MINUTES_REMAINING"
              : run.status
            : "COVERAGE_INCOMPLETE",
          { targetName: run.targetName }
        )
      : null
  const tone = active
    ? "border-primary/30 bg-primary/5"
    : run.status === "FAILED" || run.status === "TIMED_OUT"
      ? "border-destructive/50 bg-destructive/10"
      : "border-warning bg-warning/10 border-l-2"
  return (
    <section className={`rounded-lg border p-4 ${tone}`} aria-labelledby="latest-run-alert">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {active ? (
            <LoaderCircle
              className="text-primary mt-0.5 size-5 shrink-0 animate-spin"
              aria-hidden="true"
            />
          ) : (
            <AlertTriangle
              className={`mt-0.5 size-5 shrink-0 ${
                run.status === "FAILED" || run.status === "TIMED_OUT"
                  ? "text-destructive"
                  : "text-amber-600"
              }`}
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <h2 id="latest-run-alert" className="text-sm font-semibold">
              Latest scan: {presentation.label.toLowerCase()}
              {run.targetName ? ` · ${run.targetName}` : ""}
            </h2>
            {failure ? (
              <>
                <p className="text-muted-foreground mt-0.5 text-sm">{failure.cause}</p>
                <p className="text-muted-foreground mt-0.5 text-sm">{failure.effect}</p>
                <p className="text-foreground mt-1 text-sm font-medium">
                  {failure.recovery}
                  {failure.recoveryHref ? " " : ""}
                  {failure.recoveryHref ? (
                    <Link
                      href={failure.recoveryHref}
                      className="text-primary inline-flex items-center gap-1"
                    >
                      Take action <ArrowRight className="size-3.5" aria-hidden="true" />
                    </Link>
                  ) : null}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground mt-0.5 text-sm">
                {active
                  ? "This scan is still in progress. Findings appear as the scan reaches a reliable state."
                  : "Review the scan's coverage before relying on this result."}
              </p>
            )}
          </div>
        </div>
        <Link
          href={`/dashboard/scans/${run.id}`}
          className={buttonVariants({ variant: "secondary", size: "sm", className: "shrink-0" })}
        >
          {active ? "View progress" : "Review coverage"}
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </section>
  )
}
