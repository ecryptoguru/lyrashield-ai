import { getCachedSession, getCachedWorkspaceId, getCachedFindings } from "@/lib/cache"
import { FindingsClient, type FindingListItem } from "./findings-client"

export default async function FindingsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) return null

  const initialData = await getCachedFindings(workspaceId)

  return <FindingsClient workspaceId={workspaceId} initialData={initialData as unknown as FindingListItem[]} />
}
