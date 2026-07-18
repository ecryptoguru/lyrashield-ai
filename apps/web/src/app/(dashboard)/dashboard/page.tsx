import Link from "next/link"
import { Activity, ArrowRight, Bug, FileText, Play, Radar, ShieldCheck, Wrench } from "lucide-react"
import { Badge, Card, EmptyState, buttonVariants } from "@lyrashield/ui"
import { prisma } from "@lyrashield/db"
import {
  MetricCard,
  RemediationBars,
  ScoreGauge,
  ScoreTrend,
  SeverityDonut,
} from "@/components/security-visuals"
import { formatDate } from "@/lib/date-format"
import { getCachedSession, getCachedWorkspaceId, getCachedWorkspaces } from "@/lib/cache"
import { generateLaunchReadinessReportFromAggregate } from "@/lib/launch-readiness"
import { getScanPresentation } from "@/lib/scan-presentation"

export default async function DashboardPage() {
  const session = await getCachedSession()
  if (!session) return null

  const [workspaces, workspaceId] = await Promise.all([
    getCachedWorkspaces(session.userId),
    getCachedWorkspaceId(session.userId),
  ])

  if (!workspaceId || workspaces.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No workspace yet"
        description="Create your first workspace to start scanning your apps."
        action={
          <Link href="/onboarding" className={buttonVariants()}>
            <Play className="size-4" aria-hidden="true" />
            Create workspace
          </Link>
        }
      />
    )
  }

  const activeWorkspace = workspaces.find((workspace) => workspace.id === workspaceId)
  const [
    scanCount,
    openFindingCount,
    reportCount,
    findingGroups,
    completedScanCount,
    scoreSnapshots,
    recentScans,
  ] = await Promise.all([
    prisma.scan.count({ where: { workspaceId, deletedAt: null } }),
    prisma.finding.count({
      where: {
        workspaceId,
        deletedAt: null,
        status: { notIn: ["FIXED", "FALSE_POSITIVE", "DUPLICATE"] },
      },
    }),
    prisma.report.count({ where: { workspaceId, deletedAt: null } }),
    prisma.finding.groupBy({
      by: ["severity", "status", "verified"],
      where: { workspaceId, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.scan.count({
      where: { workspaceId, deletedAt: null, status: "COMPLETED" },
    }),
    prisma.scoreSnapshot.findMany({
      where: { workspaceId },
      orderBy: { computedAt: "desc" },
      take: 10,
      select: { score: true, grade: true, computedAt: true },
    }),
    prisma.scan.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        target: { select: { name: true, type: true } },
        _count: { select: { findings: { where: { deletedAt: null } } } },
      },
    }),
  ])

  const severity = Object.fromEntries(
    Object.entries(
      findingGroups.reduce<Record<string, number>>((totals, group) => {
        totals[group.severity] = (totals[group.severity] ?? 0) + group._count._all
        return totals
      }, {})
    )
  )
  const statuses = findingGroups.reduce<Record<string, number>>((totals, group) => {
    totals[group.status] = (totals[group.status] ?? 0) + group._count._all
    return totals
  }, {})
  const readiness = generateLaunchReadinessReportFromAggregate(
    findingGroups.map((group) => ({
      severity: group.severity,
      status: group.status,
      verified: group.verified,
      count: group._count._all,
    })),
    completedScanCount > 0
  )
  const fixed = statuses.FIXED ?? 0
  const inProgress =
    (statuses.FIX_READY ?? 0) +
    (statuses.PR_OPENED ?? 0) +
    (statuses.TICKET_CREATED ?? 0) +
    (statuses.FIXED_PENDING_RETEST ?? 0)
  const riskAccepted = statuses.ACCEPTED_RISK ?? 0
  const latestScore = scoreSnapshots[0] ?? null
  const trend = [...scoreSnapshots]
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
      : readiness.verdict === "NOT_EVALUATED"
        ? {
            label: "Needs evidence",
            description: "Run a scan before making a launch decision.",
            href: "/dashboard/scans?new=1",
            action: "Start a safe scan",
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
        <Link
          href="/dashboard/scans?new=1"
          className={buttonVariants({ className: "self-start sm:self-auto" })}
        >
          <Play className="size-4" aria-hidden="true" />
          Start a scan
        </Link>
      </header>

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
          </div>
          <Link href={readinessConfig.href} className={buttonVariants({ variant: "secondary" })}>
            {readinessConfig.action}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Workspace metrics">
        <MetricCard
          label="Security score"
          value={readiness.score ?? latestScore?.score ?? "—"}
          detail={
            latestScore
              ? `Grade ${latestScore.grade.replace("_PLUS", "+")}`
              : "Awaiting completed scan"
          }
          icon={ShieldCheck}
        />
        <MetricCard
          label="Open findings"
          value={openFindingCount}
          detail={`${severity.CRITICAL ?? 0} critical · ${severity.HIGH ?? 0} high`}
          icon={Bug}
        />
        <MetricCard
          label="Scans"
          value={scanCount}
          detail={`${completedScanCount} completed evidence run${completedScanCount === 1 ? "" : "s"}`}
          icon={Radar}
        />
        <MetricCard
          label="Reports"
          value={reportCount}
          detail="Immutable assurance snapshots"
          icon={FileText}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Card className="p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">Risk posture</h2>
              <p className="text-muted-foreground mt-1 text-xs">
                Latest score with the last ten completed scan snapshots.
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
          <SeverityDonut values={severity} />
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
                value: Math.max(0, openFindingCount - inProgress - riskAccepted),
                tone: "warning",
              },
              { label: "In remediation", value: inProgress, tone: "primary" },
              { label: "Fixed", value: fixed, tone: "success" },
              { label: "Risk accepted", value: riskAccepted },
            ]}
          />
        </Card>

        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-4 border-b px-5 py-4 sm:px-6">
            <div>
              <h2 className="font-semibold">Recent scan activity</h2>
              <p className="text-muted-foreground mt-1 text-xs">
                The latest worker lifecycle outcomes.
              </p>
            </div>
            <Link
              href="/dashboard/scans"
              className="text-primary flex min-h-11 items-center gap-1 text-sm font-medium"
            >
              View all <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
          {recentScans.length > 0 ? (
            <div className="divide-y">
              {recentScans.map((scan) => (
                <Link
                  key={scan.id}
                  href={`/dashboard/scans/${scan.id}`}
                  className="hover:bg-accent/60 flex min-h-16 items-center gap-3 px-5 py-3 transition-colors sm:px-6"
                >
                  <span className="bg-primary/8 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
                    <Activity className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {scan.target?.name ?? "Workspace scan"}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {formatDate(scan.createdAt)} · {scan._count.findings} findings
                    </span>
                  </span>
                  <Badge variant={getScanPresentation(scan.status).badgeVariant}>
                    {getScanPresentation(scan.status).label}
                  </Badge>
                </Link>
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground flex min-h-48 items-center justify-center px-6 text-sm">
              No scan activity yet.
            </div>
          )}
        </Card>
      </section>
    </div>
  )
}
