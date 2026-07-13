import Link from "next/link"
import { Activity, ArrowRight, Bug, FileText, Plus, Radar, ShieldCheck, Wrench } from "lucide-react"
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
            <Plus className="size-4" aria-hidden="true" />
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
    severityGroups,
    statusGroups,
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
      by: ["severity"],
      where: { workspaceId, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.finding.groupBy({
      by: ["status"],
      where: { workspaceId, deletedAt: null },
      _count: { _all: true },
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
    severityGroups.map((group) => [group.severity, group._count._all])
  )
  const statuses = Object.fromEntries(
    statusGroups.map((group) => [group.status, group._count._all])
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

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-primary text-xs font-semibold tracking-[0.15em] uppercase">
            {activeWorkspace?.name ?? "Active workspace"}
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-[-0.035em] sm:text-4xl">
            Security command center
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Monitor verified risk, remediation momentum, and release readiness from one operational
            view.
          </p>
        </div>
        <Link
          href="/dashboard/scans"
          className={buttonVariants({ className: "self-start sm:self-auto" })}
        >
          <Plus className="size-4" aria-hidden="true" />
          New scan
        </Link>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Workspace metrics">
        <MetricCard
          label="Security score"
          value={latestScore?.score ?? "—"}
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
          detail={`${recentScans.filter((scan) => scan.status === "COMPLETED").length} recently completed`}
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
            <h2 className="font-semibold">Verified risk mix</h2>
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
                Finding movement from verified risk to closure.
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
                  <Badge
                    variant={
                      scan.status === "COMPLETED"
                        ? "success"
                        : scan.status === "FAILED"
                          ? "danger"
                          : "info"
                    }
                  >
                    {scan.status.replaceAll("_", " ")}
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
