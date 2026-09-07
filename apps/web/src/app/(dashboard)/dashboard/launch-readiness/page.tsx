import type { Metadata } from "next"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { Rocket } from "lucide-react"
import { LaunchReadinessClient } from "./launch-readiness-client"
import { withWorkspaceRLS } from "@lyrashield/db"
import { projectGateReadinessReport } from "@/lib/launch-readiness"
import { getGateReadinessTargets } from "@/lib/launch-readiness-server"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"

export const metadata: Metadata = {
  title: "Launch Readiness",
}

export default async function LaunchReadinessPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <PageHeader title="Launch Readiness" icon={Rocket} />
        <NoWorkspaceState
          icon={Rocket}
          description="Create a workspace during onboarding to view launch readiness."
        />
      </div>
    )
  }

  const [groups, targets] = await Promise.all([
    withWorkspaceRLS(workspaceId, (tx) =>
      tx.finding.groupBy({
        by: ["severity", "status", "verified"],
        where: { workspaceId, deletedAt: null },
        _count: { _all: true },
      })
    ),
    getGateReadinessTargets(workspaceId),
  ])

  const initialReport = projectGateReadinessReport(
    groups.map((g) => ({ ...g, count: g._count._all })),
    targets
  )

  return <LaunchReadinessClient workspaceId={workspaceId} initialReport={initialReport} />
}
