import type { Metadata } from "next"
import Link from "next/link"
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Bug,
  CheckCircle2,
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
import { applyTargetCoverageToVerdict } from "@/lib/dashboard-overview"
import { deriveHomeNextAction } from "@/lib/home-next-action"
import { generateLaunchReadinessReportFromAggregate } from "@/lib/launch-readiness"
import { getScanPresentation, isActiveScan } from "@/lib/scan-presentation"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { dashboardPrimaryAction } from "@/components/trust-command-center.utils"

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
  const overview = await getCachedDashboardOverview(workspaceId)
  const {
    targets,
    openIssues,
    openIssuesBySeverity,
    findingGroups,
    completedRunCount,
    scoreHistory,
    reportCount,
    project,
    latestRun,
    lastEvaluatedAssessment,
    recentRuns,
    remediation,
  } = overview

  const targetCount = targets.total
  const readinessBase = generateLaunchReadinessReportFromAggregate(
    findingGroups.map((group) => ({
      severity: group.severity,
      status: group.status,
      verified: group.verified,
      count: group.count,
    })),
    completedRunCount > 0,
    {
      evaluated: targets.assessed + targets.partiallyAssessed > 0,
      reason:
        "No scanner successfully evaluated a target in this workspace. Open the latest run's coverage notice for the specific reason.",
    }
  )
  // A positive verdict is refused while any active target has no usable,
  // non-expired evidence — a clean finding sheet is not a launch decision for
  // targets nobody has been able to inspect.
  const { verdict, coverageCondition } = applyTargetCoverageToVerdict(
    readinessBase.verdict,
    targets
  )
  const readiness = {
    ...readinessBase,
    verdict,
    conditions: coverageCondition
      ? [...readinessBase.conditions, coverageCondition]
      : readinessBase.conditions,
  }

  const primaryAction = dashboardPrimaryAction(targetCount)
  const nextAction = deriveHomeNextAction(
    { targets, lastEvaluatedAssessment, remediation, reportCount },
    openIssues
  )

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
  // read model already excludes scores from runs that evaluated nothing.
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

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      {/* 1 — workspace label and one primary CTA */}
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
            {targetCount === 0 ? (
              <Plus className="size-4" aria-hidden="true" />
            ) : (
              <Play className="size-4" aria-hidden="true" />
            )}
            {primaryAction.label}
          </Link>
        </div>
      </header>

      {/* One contextual next action — replaces the previous tour + checklist pair. */}
      {nextAction && (
        <section
          className="border-primary/30 bg-primary/[0.04] rounded-xl border p-5 sm:p-6"
          aria-labelledby="home-next-action"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                {nextAction.eyebrow}
              </p>
              <h2 id="home-next-action" className="mt-1 text-xl font-bold tracking-tight">
                {nextAction.title}
              </h2>
              <p className="text-muted-foreground mt-1.5 max-w-2xl text-sm">
                {nextAction.description}
              </p>
            </div>
            <Link
              href={nextAction.href}
              className={`${buttonVariants({ className: "shrink-0" })} min-h-11`}
            >
              {nextAction.cta}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </section>
      )}

      {/* 2 — current posture and exact evidence scope */}
      <TrustCommandCenter
        productName={project?.name ?? activeWorkspace?.name ?? "Workspace"}
        mode={latestRun?.mode ?? null}
        trustPlanData={project?.trustPlan}
        latestScore={latestScore}
      />

      {/* 3 — latest run warning/progress when it needs attention */}
      {latestRunAlert && <LatestRunAlert run={latestRunAlert} />}

      {/* 4 — four compact metrics, each naming its evidence scope */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Workspace metrics">
        <MetricCard
          label="Security score"
          value={latestScore?.score ?? "—"}
          detail={
            latestScore
              ? `Grade ${latestScore.grade.replace("_PLUS", "+")} · ${latestScore.targetName}`
              : "No evaluated review yet"
          }
          icon={ShieldCheck}
        />
        <MetricCard
          label="Open issues"
          value={openIssues.total}
          detail={`${openIssuesBySeverity.CRITICAL ?? 0} critical · ${openIssuesBySeverity.HIGH ?? 0} high · workspace-wide`}
          icon={Bug}
        />
        <MetricCard
          label="Target coverage"
          value={targetCount === 0 ? "—" : `${targets.assessed}/${targetCount}`}
          detail={coverageLabel}
          icon={Crosshair}
        />
        <MetricCard
          label="Independently verified"
          value={openIssues.independentlyVerified}
          detail="Backed by an independent verification receipt"
          icon={CheckCircle2}
        />
      </section>

      {/* 5 — recent activity */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b px-5 py-4 sm:px-6">
          <div>
            <h2 className="font-semibold">Recent activity</h2>
            <p className="text-muted-foreground mt-1 text-xs">Your most recent runs.</p>
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
                      {formatDateTime(run.createdAt)} · {run.findingCount} issue
                      {run.findingCount === 1 ? "" : "s"} from this run
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
              title="No run activity yet"
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
                  {targetCount === 0 ? (
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

      {/* 6 — secondary analytics and remediation details */}
      <section className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Card className="p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">Risk posture</h2>
              <p className="text-muted-foreground mt-1 text-xs">
                {latestScore
                  ? `Score from the ${latestScore.completedAtLabel} review of ${latestScore.targetName}, with recent evaluated snapshots.`
                  : "No evaluated review yet."}
              </p>
            </div>
            <Badge
              variant={latestScore ? (latestScore.score >= 80 ? "success" : "warning") : "muted"}
            >
              {latestScore ? "Evaluated" : "Not evaluated"}
            </Badge>
          </div>
          <div className="grid items-center gap-6 md:grid-cols-[auto_1fr]">
            <ScoreGauge score={latestScore?.score ?? null} grade={latestScore?.grade ?? null} />
            <ScoreTrend points={trend} />
          </div>
        </Card>

        <Card className="p-5 sm:p-6">
          <div className="mb-5">
            <h2 className="font-semibold">Retained issue mix</h2>
            <p className="text-muted-foreground mt-1 text-xs">
              All retained issues grouped by severity, workspace-wide.
            </p>
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
                Current issue movement from review through closure.
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
              Latest run: {presentation.label.toLowerCase()}
              {run.targetName ? ` · ${run.targetName}` : ""}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {active
                ? "This run is still in progress. Findings appear as the run reaches a reliable state."
                : (run.userSafeFailure ??
                  "The latest run completed but no scanner could evaluate the target, so there is no evidence to judge. This is not a clean result.")}
            </p>
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
