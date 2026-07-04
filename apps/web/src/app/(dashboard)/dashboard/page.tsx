import Link from "next/link"
import { Crosshair, Bug, ShieldCheck, Plus } from "lucide-react"
import { Card, Badge, EmptyState, Button } from "@lyrashield/ui"
import { getCachedSession, getCachedWorkspaces, getCachedDashboardStats } from "@/lib/cache"

export default async function DashboardPage() {
  const session = await getCachedSession()

  if (!session) return null

  const workspaces = await getCachedWorkspaces(session.userId)
  const workspaceIds = workspaces.map((w) => w.id)

  const { scanCount, findingCount, projectCount } = await getCachedDashboardStats(workspaceIds.join(","))

  const stats = [
    { label: "Projects", value: projectCount, icon: ShieldCheck },
    { label: "Scans", value: scanCount, icon: Crosshair },
    { label: "Findings", value: findingCount, icon: Bug },
  ]

  return (
    <div>
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">Welcome back, {session.userName}</p>
        </div>
        <Link href="/dashboard/scans" title="Scan engine coming soon — view scan history">
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
              <Card key={stat.label} className="group p-5 transition-all duration-200 hover:shadow-md">
                <div className="flex items-center justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/5 transition-colors group-hover:bg-primary/10">
                    <stat.icon className="h-5 w-5 text-primary" aria-hidden="true" />
                  </div>
                  <span className="text-3xl font-bold tracking-tight">{stat.value}</span>
                </div>
                <p className="mt-3 text-sm font-medium text-muted-foreground">{stat.label}</p>
              </Card>
            ))}
          </div>

          <div className="mt-8">
            <h2 className="mb-4 text-lg font-semibold">Your Workspaces</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {workspaces.map((ws) => (
                <Card key={ws.id} className="p-5 transition-all duration-200 hover:shadow-md">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="font-semibold">{ws.name}</h3>
                    <Badge variant={ws.role === "OWNER" ? "info" : "muted"}>{ws.role}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Plan: {ws.plan} · Mode: {ws.mode}
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
