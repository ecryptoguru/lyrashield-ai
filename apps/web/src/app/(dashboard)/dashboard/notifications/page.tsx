import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { Bell } from "lucide-react"
import { NotificationsClient } from "./notifications-client"
import { NotificationPreferences } from "@/components/notification-preferences"
import { NoWorkspaceState } from "@/components/no-workspace-state"

export default async function NotificationsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <NoWorkspaceState
          icon={Bell}
          description="Create a workspace during onboarding to view notifications."
        />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <NotificationsClient workspaceId={workspaceId} />
      <NotificationPreferences />
    </div>
  )
}
