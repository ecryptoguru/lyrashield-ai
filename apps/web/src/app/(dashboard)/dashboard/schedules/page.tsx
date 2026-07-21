import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { EmptyState } from "@lyrashield/ui"
import { CalendarClock } from "lucide-react"
import { SchedulesClient } from "./schedules-client"

export default async function SchedulesPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Schedules</h1>
        <EmptyState
          icon={CalendarClock}
          title="No workspace yet"
          description="Create a workspace during onboarding to manage schedules."
        />
      </div>
    )
  }

  return <SchedulesClient workspaceId={workspaceId} />
}
