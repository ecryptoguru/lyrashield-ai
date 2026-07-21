import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { EmptyState } from "@lyrashield/ui"
import { Bell } from "lucide-react"
import { NotificationsClient } from "./notifications-client"

export default async function NotificationsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <EmptyState
          icon={Bell}
          title="No workspace yet"
          description="Create a workspace during onboarding to view notifications."
        />
      </div>
    )
  }

  return <NotificationsClient workspaceId={workspaceId} />
}
