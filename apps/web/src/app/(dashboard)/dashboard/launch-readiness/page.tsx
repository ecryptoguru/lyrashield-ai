import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { LaunchReadinessClient } from "./launch-readiness-client"

export default async function LaunchReadinessPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) return null

  return <LaunchReadinessClient workspaceId={workspaceId} />
}
