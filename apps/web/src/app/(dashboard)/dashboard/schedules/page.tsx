import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { SchedulesClient } from "./schedules-client"

export default async function SchedulesPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) return null

  return <SchedulesClient workspaceId={workspaceId} />
}
