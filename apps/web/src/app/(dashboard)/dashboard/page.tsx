import { prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import Link from "next/link"
import { Crosshair, Bug, ShieldCheck, Plus } from "lucide-react"
import { Card, Badge, EmptyState, Button } from "@lyrashield/ui"

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
        <Link href="/dashboard/scans">
          <Button>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New Scan
          </Button>
        </Link>
      </div>

      {workspaces.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No workspace yet"
          description="Create your first workspace to start scanning your apps."
          action={
            <Link href="/onboarding">
              <Button>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Create workspace
              </Button>
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {stats.map((stat) => (
              <Card key={stat.label} className="p-6">
                <div className="mb-2 flex items-center justify-between">
                  <stat.icon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                  <span className="text-2xl font-bold">{stat.value}</span>
                </div>
                <p className="text-sm text-muted-foreground">{stat.label}</p>
              </Card>
            ))}
          </div>

          <div className="mt-8">
            <h2 className="mb-4 text-lg font-semibold">Your Workspaces</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {workspaces.map(({ workspace, role }) => (
                <Card key={workspace.id} className="p-6">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="font-semibold">{workspace.name}</h3>
                    <Badge>{role}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Plan: {workspace.plan} · Mode: {workspace.mode}
                  </p>
                </Card>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
