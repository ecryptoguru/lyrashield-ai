import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NotificationsClient } from "./notifications-client"

export default async function NotificationsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) return null

  return <NotificationsClient workspaceId={workspaceId} />
}
