import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { EmptyState } from "@lyrashield/ui"
import { Rocket } from "lucide-react"
import { LaunchReadinessClient } from "./launch-readiness-client"
import { prisma } from "@lyrashield/db"
import { generateLaunchReadinessReportFromAggregate } from "@/lib/launch-readiness"

export default async function LaunchReadinessPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Launch Readiness</h1>
        <EmptyState
          icon={Rocket}
          title="No workspace yet"
          description="Create a workspace during onboarding to view launch readiness."
        />
      </div>
    )
  }

  const [groups, completedScanCount] = await Promise.all([
    prisma.finding.groupBy({
      by: ["severity", "status", "verified"],
      where: { workspaceId, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.scan.count({
      where: { workspaceId, status: "COMPLETED", deletedAt: null },
    }),
  ])

  const initialReport = generateLaunchReadinessReportFromAggregate(
    groups.map((g) => ({ ...g, count: g._count._all })),
    completedScanCount > 0
  )

  return <LaunchReadinessClient workspaceId={workspaceId} initialReport={initialReport} />
}
