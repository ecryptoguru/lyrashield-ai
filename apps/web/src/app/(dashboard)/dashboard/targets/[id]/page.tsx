import { getSession } from "@lyrashield/auth/server"
import { prisma } from "@lyrashield/db"
import { redirect, notFound } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, GitBranch, Globe, Bug, Crosshair } from "lucide-react"
import { Card, Badge } from "@lyrashield/ui"

export default async function TargetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await getSession()
  if (!session) redirect("/sign-in")

  const { id } = await params

  const target = await prisma.target.findUnique({
    where: { id },
    include: {
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
      _count: { select: { scans: true, findings: true } },
    },
  })

  if (!target || target.deletedAt) {
    notFound()
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId: target.workspaceId, userId: session.userId },
    },
  })

  if (!membership || membership.status !== "active") {
    redirect("/dashboard")
  }

  return (
    <div>
      <Link
        href="/dashboard/targets"
        className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to targets
      </Link>

      <div className="mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{target.name}</h1>
          <Badge>
            {target.type === "REPO" ? <GitBranch className="h-3 w-3" aria-hidden="true" /> : <Globe className="h-3 w-3" aria-hidden="true" />}
            {target.type}
          </Badge>
          <Badge variant={target.status === "active" ? "success" : "muted"}>
            {target.status}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Environment: {target.environment}
          {target.project && ` · Project: ${target.project.name}`}
        </p>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="p-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Crosshair className="h-4 w-4" aria-hidden="true" />
            Total Scans
          </div>
          <p className="mt-2 text-2xl font-bold">{target._count.scans}</p>
        </Card>
        <Card className="p-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bug className="h-4 w-4" aria-hidden="true" />
            Total Findings
          </div>
          <p className="mt-2 text-2xl font-bold">{target._count.findings}</p>
        </Card>
        <Card className="p-6">
          <div className="text-sm text-muted-foreground">Last Scan</div>
          <p className="mt-2 text-2xl font-bold">
            {target.lastScanAt ? new Date(target.lastScanAt).toLocaleDateString() : "Never"}
          </p>
        </Card>
      </div>

      {target.type === "REPO" && (
        <div className="mb-6 rounded-lg border p-6">
          <h2 className="mb-4 text-lg font-semibold">Repository Details</h2>
          <dl className="grid grid-cols-2 gap-4 text-sm">
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
        <div className="mb-6 rounded-lg border p-6">
          <h2 className="mb-4 text-lg font-semibold">URL Details</h2>
          <dl className="grid grid-cols-1 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">URL</dt>
              <dd className="font-medium">
                <a href={target.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  {target.url}
                </a>
              </dd>
            </div>
          </dl>
        </div>
      )}

      <div className="rounded-lg border">
        <div className="border-b p-4">
          <h2 className="text-lg font-semibold">Recent Scans</h2>
        </div>
        {target.scans.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No scans yet for this target.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Goal</th>
                <th className="px-4 py-3 text-left font-medium">Mode</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {target.scans.map((scan) => (
                <tr key={scan.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium">{scan.goal}</td>
                  <td className="px-4 py-3">{scan.mode}</td>
                  <td className="px-4 py-3">
                    <Badge variant={
                      scan.status === "COMPLETED" ? "success" :
                      scan.status === "FAILED" ? "danger" :
                      scan.status === "RUNNING" ? "info" :
                      "muted"
                    }>
                      {scan.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
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
