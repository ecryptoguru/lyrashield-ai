import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { ReportsClient } from "./reports-client"

export default async function ReportsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) return null

  return <ReportsClient workspaceId={workspaceId} />
}
