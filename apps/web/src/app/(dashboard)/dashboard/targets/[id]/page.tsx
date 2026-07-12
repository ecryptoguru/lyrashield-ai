import { getSession } from "@lyrashield/auth/server"
import { prisma } from "@lyrashield/db"
import { redirect, notFound } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, GitBranch, Globe, Bug, Crosshair } from "lucide-react"
import { Card, Badge } from "@lyrashield/ui"
import { ScorecardControls } from "./scorecard-controls"

export default async function TargetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) redirect("/sign-in")

  const { id } = await params

  const target = await prisma.target.findFirst({
    where: {
      id,
      deletedAt: null,
      workspace: { members: { some: { userId: session.userId, status: "active" } } },
    },
    include: {
      workspace: {
        select: {
          members: {
            where: { userId: session.userId, status: "active" },
            take: 1,
            select: { role: true },
          },
        },
      },
      project: { select: { id: true, name: true } },
      scans: {
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          goal: true,
          status: true,
          mode: true,
          createdAt: true,
          startedAt: true,
          endedAt: true,
        },
      },
      scoreSnapshots: {
        orderBy: { computedAt: "desc" },
        take: 1,
        select: {
          score: true,
          grade: true,
          shareEligible: true,
          expiresAt: true,
          shares: {
            where: { revokedAt: null },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              slug: true,
              referralCode: { select: { code: true } },
            },
          },
        },
      },
      _count: { select: { scans: true, findings: true } },
    },
  })

  if (!target) {
    notFound()
  }

  const membership = target.workspace.members[0]!
  const latestScore = target.scoreSnapshots[0]
  const scoreExpired = latestScore ? latestScore.expiresAt <= new Date() : false

  return (
    <div>
      <Link
        href="/dashboard/targets"
        className="text-muted-foreground hover:text-foreground mb-4 flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="h-3 w-3" aria-hidden="true" />
        Back to targets
      </Link>

      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{target.name}</h1>
          <Badge>
            {target.type === "REPO" ? (
              <GitBranch className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Globe className="h-3 w-3" aria-hidden="true" />
            )}
            {target.type}
          </Badge>
          <Badge variant={target.status === "active" ? "success" : "muted"}>{target.status}</Badge>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          Environment: {target.environment}
          {target.project && ` · Project: ${target.project.name}`}
        </p>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="group p-5 transition-all duration-200 hover:shadow-md">
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Crosshair className="text-primary h-4 w-4" aria-hidden="true" />
            Total Scans
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight">{target._count.scans}</p>
        </Card>
        <Card className="group p-5 transition-all duration-200 hover:shadow-md">
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Bug className="text-primary h-4 w-4" aria-hidden="true" />
            Total Findings
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight">{target._count.findings}</p>
        </Card>
        <Card className="group p-5 transition-all duration-200 hover:shadow-md">
          <div className="text-muted-foreground text-sm">Last Scan</div>
          <p className="mt-2 text-2xl font-bold tracking-tight">
            {target.lastScanAt ? new Date(target.lastScanAt).toLocaleDateString() : "Never"}
          </p>
        </Card>
      </div>

      {latestScore && (
        <div className="bg-card mb-6 rounded-xl border p-4 shadow-sm sm:p-6">
          <h2 className="text-lg font-semibold">LyraShield Score</h2>
          <p className="text-primary mt-2 font-mono text-4xl font-bold">
            {latestScore.grade.replace("_PLUS", "+")} · {latestScore.score}
          </p>
          <p className="text-muted-foreground mt-2 text-sm">
            {scoreExpired
              ? "This score is stale — run a new scan to refresh it before sharing."
              : latestScore.shareEligible
                ? "Eligible for a public scorecard."
                : "Provisional score — run a Standard or Deep scan on the configured default branch to share."}
          </p>
          {latestScore.shareEligible && !scoreExpired && (
            <ScorecardControls
              targetId={target.id}
              workspaceId={target.workspaceId}
              grade={latestScore.grade}
              canPublish={["OWNER", "ADMIN", "SECURITY_ADMIN", "APPSEC_MANAGER"].includes(
                membership.role
              )}
              existingShare={
                latestScore.shares[0]
                  ? {
                      id: latestScore.shares[0].id,
                      slug: latestScore.shares[0].slug,
                      url: latestScore.shares[0].referralCode?.code
                        ? `/score/${latestScore.shares[0].slug}?ref=${latestScore.shares[0].referralCode.code}`
                        : `/score/${latestScore.shares[0].slug}`,
                    }
                  : undefined
              }
            />
          )}
        </div>
      )}

      {target.type === "REPO" && (
        <div className="bg-card mb-6 rounded-xl border p-4 shadow-sm sm:p-6">
          <h2 className="mb-4 text-lg font-semibold">Repository Details</h2>
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Provider</dt>
              <dd className="font-medium">{target.repoProvider}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Repository</dt>
              <dd className="font-medium">{target.repoFullName}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Branch</dt>
              <dd className="font-medium">{target.branch}</dd>
            </div>
          </dl>
        </div>
      )}

      {target.type !== "REPO" && target.url && (
        <div className="bg-card mb-6 rounded-xl border p-4 shadow-sm sm:p-6">
          <h2 className="mb-4 text-lg font-semibold">URL Details</h2>
          <dl className="grid grid-cols-1 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">URL</dt>
              <dd className="font-medium">
                <a
                  href={target.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {target.url}
                </a>
              </dd>
            </div>
          </dl>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border shadow-sm">
        <div className="border-b p-4">
          <h2 className="text-lg font-semibold">Recent Scans</h2>
        </div>
        {target.scans.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            No scans yet for this target.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/30 border-b">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Goal</th>
                <th className="px-4 py-3 text-left font-semibold">Mode</th>
                <th className="px-4 py-3 text-left font-semibold">Status</th>
                <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Date</th>
              </tr>
            </thead>
            <tbody>
              {target.scans.map((scan) => (
                <tr key={scan.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium">{scan.goal}</td>
                  <td className="px-4 py-3">{scan.mode}</td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={
                        scan.status === "COMPLETED"
                          ? "success"
                          : scan.status === "FAILED"
                            ? "danger"
                            : scan.status === "RUNNING"
                              ? "info"
                              : "muted"
                      }
                    >
                      {scan.status}
                    </Badge>
                  </td>
                  <td className="text-muted-foreground hidden px-4 py-3 sm:table-cell">
                    {new Date(scan.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
