import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { FileText } from "lucide-react"
import { ReportsClient } from "./reports-client"
import { NoWorkspaceState } from "@/components/no-workspace-state"

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
        <NoWorkspaceState
          icon={FileText}
          description="Create a workspace during onboarding to manage reports."
        />
      </div>
    )
  }

  const { scanId } = await searchParams
  return <ReportsClient workspaceId={workspaceId} initialScanId={scanId} />
}
