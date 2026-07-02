import { prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import Link from "next/link"
import { Crosshair, Bug, ShieldCheck, Plus } from "lucide-react"

export default async function DashboardPage() {
  const session = await getSession()

  if (!session) return null

  const workspaces = await prisma.workspaceMember.findMany({
    where: { userId: session.userId, status: "active" },
    include: { workspace: true },
  })

  const workspaceIds = workspaces.map((w) => w.workspaceId)

  const [scanCount, findingCount, projectCount] =
    workspaceIds.length > 0
      ? await Promise.all([
          prisma.scan.count({ where: { workspaceId: { in: workspaceIds } } }),
          prisma.finding.count({ where: { workspaceId: { in: workspaceIds } } }),
          prisma.project.count({ where: { workspaceId: { in: workspaceIds } } }),
        ])
      : [0, 0, 0]

  const stats = [
    { label: "Projects", value: projectCount, icon: ShieldCheck },
    { label: "Scans", value: scanCount, icon: Crosshair },
    { label: "Findings", value: findingCount, icon: Bug },
  ]

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Welcome back, {session.userName}</p>
        </div>
        <Link
          href="/dashboard/scans"
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Scan
        </Link>
      </div>

      {workspaces.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <ShieldCheck className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
          <h2 className="mb-2 text-lg font-semibold">No workspace yet</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Create your first workspace to start scanning your apps.
          </p>
          <Link
            href="/onboarding"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Create workspace
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {stats.map((stat) => (
              <div key={stat.label} className="rounded-lg border p-6">
                <div className="mb-2 flex items-center justify-between">
                  <stat.icon className="h-5 w-5 text-muted-foreground" />
                  <span className="text-2xl font-bold">{stat.value}</span>
                </div>
                <p className="text-sm text-muted-foreground">{stat.label}</p>
              </div>
            ))}
          </div>

          <div className="mt-8">
            <h2 className="mb-4 text-lg font-semibold">Your Workspaces</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {workspaces.map(({ workspace, role }) => (
                <div key={workspace.id} className="rounded-lg border p-6">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="font-semibold">{workspace.name}</h3>
                    <span className="rounded-full bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground">
                      {role}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Plan: {workspace.plan} · Mode: {workspace.mode}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
