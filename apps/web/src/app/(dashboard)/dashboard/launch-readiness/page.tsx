import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { EmptyState } from "@lyrashield/ui"
import { Rocket } from "lucide-react"
import { LaunchReadinessClient } from "./launch-readiness-client"

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

  return <LaunchReadinessClient workspaceId={workspaceId} />
}
