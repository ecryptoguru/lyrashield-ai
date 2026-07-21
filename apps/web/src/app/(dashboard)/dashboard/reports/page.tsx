import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { EmptyState } from "@lyrashield/ui"
import { FileText } from "lucide-react"
import { ReportsClient } from "./reports-client"

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ scanId?: string }>
}) {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
        <EmptyState
          icon={FileText}
          title="No workspace yet"
          description="Create a workspace during onboarding to manage reports."
        />
      </div>
    )
  }

  const { scanId } = await searchParams
  return <ReportsClient workspaceId={workspaceId} initialScanId={scanId} />
}
