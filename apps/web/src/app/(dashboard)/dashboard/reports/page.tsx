import type { Metadata } from "next"
import { prisma } from "@lyrashield/db"
import { FileText } from "lucide-react"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { ReportsClient } from "./reports-client"

export const metadata: Metadata = {
  title: "Reports",
}

/**
 * W2-10: Reports is a direct destination again. The `scanId` and `targetId`
 * query scope used by report-generation deep links is preserved, and the
 * legacy `findings?tab=reports` route keeps working by redirecting here.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ scanId?: string; targetId?: string }>
}) {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <PageHeader
          title="Reports"
          description="Immutable assurance snapshots from completed scan evidence."
        />
        <NoWorkspaceState
          icon={FileText}
          description="Create a workspace during onboarding to create reports."
        />
      </div>
    )
  }

  const params = await searchParams

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Create immutable assurance snapshots from completed scan evidence. Reports summarize retained evidence; they do not create new verification."
      />
      <ReportsClient
        workspaceId={workspaceId}
        initialScanId={params.scanId}
        initialTargetId={params.targetId}
      />
    </div>
  )
}
