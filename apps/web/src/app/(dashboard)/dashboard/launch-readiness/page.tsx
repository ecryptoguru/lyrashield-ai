import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { Rocket } from "lucide-react"
import { LaunchReadinessClient } from "./launch-readiness-client"
import { prisma } from "@lyrashield/db"
import { generateLaunchReadinessReportFromAggregate } from "@/lib/launch-readiness"
import { NoWorkspaceState } from "@/components/no-workspace-state"

export default async function LaunchReadinessPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Launch Readiness</h1>
        <NoWorkspaceState
          icon={Rocket}
          description="Create a workspace during onboarding to view launch readiness."
        />
      </div>
    )
  }

  const [groups, completedScanCount, evaluatedCoverageCount] = await Promise.all([
    prisma.finding.groupBy({
      by: ["severity", "status", "verified"],
      where: { workspaceId, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.scan.count({
      where: { workspaceId, status: "COMPLETED", deletedAt: null },
    }),
    prisma.scanCoverageReceipt.count({
      where: {
        status: "COMPLETED",
        scan: { workspaceId, status: "COMPLETED", deletedAt: null },
      },
    }),
  ])

  const initialReport = generateLaunchReadinessReportFromAggregate(
    groups.map((g) => ({ ...g, count: g._count._all })),
    completedScanCount > 0,
    {
      evaluated: evaluatedCoverageCount > 0,
      reason:
        "No scanner successfully evaluated this target. Open the latest run's coverage notice for the specific reason.",
    }
  )

  return <LaunchReadinessClient workspaceId={workspaceId} initialReport={initialReport} />
}
