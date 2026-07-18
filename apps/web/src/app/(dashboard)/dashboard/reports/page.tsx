import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { ReportsClient } from "./reports-client"

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ scanId?: string }>
}) {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) return null

  const { scanId } = await searchParams
  return <ReportsClient workspaceId={workspaceId} initialScanId={scanId} />
}
