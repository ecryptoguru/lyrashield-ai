import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { Bell } from "lucide-react"
import { NotificationsClient } from "./notifications-client"
import { NotificationPreferences } from "@/components/notification-preferences"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"

export default async function NotificationsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <PageHeader
          title="Notifications"
          description="Scan alerts, finding warnings, and fix PR updates"
        />
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
