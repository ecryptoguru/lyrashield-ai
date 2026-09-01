import type { Metadata } from "next"
import Link from "next/link"
import {
  Activity,
  ArrowRight,
  Bug,
  CheckCircle2,
  Circle,
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
import { formatDate } from "@/lib/date-format"
import { HOME_LABEL } from "@/lib/terminology"
import {
  getCachedSession,
  getCachedWorkspaceId,
  getCachedWorkspaces,
  getCachedDashboardOverview,
} from "@/lib/cache"
import { TrustCommandCenter } from "@/components/trust-command-center"
import { GetStartedChecklist } from "@/components/get-started-checklist"
import { applyTargetCoverageToVerdict } from "@/lib/dashboard-overview"
import { generateLaunchReadinessReportFromAggregate } from "@/lib/launch-readiness"
import { getScanPresentation } from "@/lib/scan-presentation"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { dashboardPrimaryAction } from "@/components/trust-command-center.utils"
import { FeatureTour } from "@/components/feature-tour"

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

  const latestScore =
    lastEvaluatedAssessment &&
    lastEvaluatedAssessment.score !== null &&
    lastEvaluatedAssessment.grade !== null
      ? {
          score: lastEvaluatedAssessment.score,
          grade: lastEvaluatedAssessment.grade,
        }
      : null
  const primaryAction = dashboardPrimaryAction(targetCount)

  // The trend plots only snapshots bound to scans with usable coverage — the
  // read model already excludes scores from runs that evaluated nothing.
  const trend = [...scoreHistory]
    .reverse()
    .map((snapshot) => ({ label: formatDate(snapshot.computedAt), score: snapshot.score }))
  const readinessConfig =
    readiness.verdict === "GO"
      ? {
          label: "Ready to launch",
          description: "Current scan evidence has no unresolved launch blockers.",
          href: "/dashboard/launch-readiness",
          action: "Review launch decision",
          className: "border-success bg-success/10",
        }
      : readiness.verdict === "INCONCLUSIVE"
        ? {
            label: "Inconclusive — nothing was checked",
            description:
              "The last run completed but no scanner could evaluate the target, so there is no evidence to judge. This is not a clean result.",
            href: "/dashboard/scans",
            action: "Review coverage",
            className: "border-warning bg-warning/10",
          }
        : readiness.verdict === "NOT_EVALUATED"
          ? {
              label: "Needs evidence",
              description:
                targetCount === 0
                  ? "Add a target before running your first scan."
                  : "Run a scan before making a launch decision.",
              href: primaryAction.href,
              action: primaryAction.label,
              className: "border-warning bg-warning/10",
            }
          : {
              label: "Needs action",
              description:
                readiness.conditions[0] ?? "Review the remaining evidence before you launch.",
              href: "/dashboard/findings",
              action: "Review blockers",
              className: "border-destructive bg-destructive/10",
            }

  const assuranceSteps = [
    { label: "Target ready", complete: targetCount > 0, href: "/dashboard/targets" },
    {
      // A completed run that evaluated nothing has not captured evidence.
      label: "Evidence captured",
      complete: targets.assessed + targets.partiallyAssessed > 0,
      href: targetCount === 0 ? null : primaryAction.href,
    },
    {
      label: "Blockers cleared",
      complete: readiness.verdict === "GO",
      href:
        targets.assessed + targets.partiallyAssessed === 0
          ? null
          : readiness.verdict === "NOT_EVALUATED"
            ? primaryAction.href
            : "/dashboard/findings",
    },
    {
      label: "Assurance shared",
      complete: reportCount > 0,
      href:
        targets.assessed + targets.partiallyAssessed > 0 ? "/dashboard/findings?tab=reports" : null,
    },
  ]

  // null when nothing has run yet — the card omits the depth clause rather than claiming one.
  const commandMode = latestRun?.mode ?? null

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
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

      {/* One-time five-step feature tour for new users (replaces the removed
          Guided/Pro mode split). Dismissible per workspace. */}
      <FeatureTour workspaceId={workspaceId} />

      {/* First-run guide for brand-new workspaces (zero completed scans). The
          full metric grid below is the returning-user view; this is what makes
          the first five minutes simple and engaging. Dismissible per workspace. */}
      {completedRunCount === 0 && (
        <GetStartedChecklist workspaceId={workspaceId} steps={assuranceSteps} />
      )}

      <TrustCommandCenter
        productName={project?.name ?? activeWorkspace?.name ?? "Workspace"}
        mode={commandMode}
        assetCount={targetCount}
        riskScore={project?.riskScore ?? 100}
        trustPlanData={project?.trustPlan}
        completedScanCount={completedRunCount}
        latestScore={latestScore ? { score: latestScore.score, grade: latestScore.grade } : null}
      />

      <section
        className={`border-l-2 p-5 sm:p-6 ${readinessConfig.className}`}
        aria-labelledby="launch-verdict"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-[0.14em] uppercase">Launch verdict</p>
            <h2 id="launch-verdict" className="mt-1 text-2xl font-bold tracking-tight">
              {readinessConfig.label}
            </h2>
            <p className="text-foreground/80 mt-2 max-w-2xl text-sm">
              {readinessConfig.description}
            </p>
            {/* Two separately scoped messages: the latest run needs attention,
                while the last evaluated assessment remains the newest usable
                evidence for its named target. */}
            {readiness.verdict === "INCONCLUSIVE" && lastEvaluatedAssessment && (
              <p className="text-foreground/80 mt-1 max-w-2xl text-sm">
                Last evaluated assessment: {lastEvaluatedAssessment.targetName} on{" "}
                {formatDate(lastEvaluatedAssessment.completedAt)}
                {latestScore
                  ? ` — grade ${latestScore.grade.replace("_PLUS", "+")} (${latestScore.score}/100)`
                  : ""}
                , coverage {lastEvaluatedAssessment.coverageState.toLowerCase()}.
              </p>
            )}
            {targets.unassessed > 0 && targetCount > 0 && (
              <p className="text-foreground/80 mt-1 max-w-2xl text-sm">
                {targets.unassessed} of {targetCount} target{targetCount === 1 ? "" : "s"} has no
                usable review evidence yet.
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {assuranceSteps.map((step) => {
                const Icon = step.complete ? CheckCircle2 : Circle
                const content = (
                  <>
                    <Icon
                      className={
                        step.complete ? "text-success size-4" : "text-muted-foreground size-4"
                      }
                      aria-hidden="true"
                    />
                    {step.label}
                  </>
                )
                return step.href ? (
                  <Link
                    key={step.label}
                    href={step.href}
                    className="flex items-center gap-1.5 text-xs font-medium hover:underline"
                  >
                    {content}
                  </Link>
                ) : (
                  <span
                    key={step.label}
                    className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium"
                  >
                    {content}
                  </span>
                )
              })}
            </div>
          </div>
          {targetCount > 0 && (
            <Link href={readinessConfig.href} className={buttonVariants({ variant: "secondary" })}>
              {readinessConfig.action}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          )}
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2" aria-label="Workspace metrics">
        <MetricCard
          label="Security score"
          value={latestScore?.score ?? "—"}
          detail={
            latestScore
              ? `Grade ${latestScore.grade.replace("_PLUS", "+")} · ${lastEvaluatedAssessment?.targetName ?? "workspace"}`
              : completedRunCount > 0
                ? "Score snapshot unavailable"
                : "Awaiting completed scan"
          }
          icon={ShieldCheck}
        />
        <MetricCard
          label="Open findings"
          value={openIssues.total}
          detail={`${openIssuesBySeverity.CRITICAL ?? 0} critical · ${openIssuesBySeverity.HIGH ?? 0} high · workspace-wide`}
          icon={Bug}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Card className="p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">Risk posture</h2>
              <p className="text-muted-foreground mt-1 text-xs">
                {lastEvaluatedAssessment
                  ? `Score from the ${formatDate(lastEvaluatedAssessment.completedAt)} review of ${lastEvaluatedAssessment.targetName}.`
                  : "No evaluated review yet."}
              </p>
            </div>
            <Badge
              variant={
                latestScore && latestScore.score >= 80
                  ? "success"
                  : latestScore
                    ? "warning"
                    : "muted"
              }
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
            <h2 className="font-semibold">Retained finding mix</h2>
            <p className="text-muted-foreground mt-1 text-xs">
              All retained findings grouped by severity.
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

        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-4 border-b px-5 py-4 sm:px-6">
            <div>
              <h2 className="font-semibold">Recent scan activity</h2>
              <p className="text-muted-foreground mt-1 text-xs">Your most recent reviews.</p>
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
                        {formatDate(run.createdAt)} · {run.findingCount} finding
                        {run.findingCount === 1 ? "" : "s"}
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
                    : "Run your first scan to see activity here."
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
      </section>
    </div>
  )
}
