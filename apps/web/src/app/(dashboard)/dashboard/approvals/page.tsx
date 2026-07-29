import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { listApprovals, prisma } from "@lyrashield/db"
import { EmptyState } from "@lyrashield/ui"
import { ClipboardCheck } from "lucide-react"
import { ApprovalsClient } from "./approvals-client"

export default async function ApprovalsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)

  const [approvals, hasProposals] = await Promise.all([
    workspaceId ? listApprovals({ workspaceId, status: "PENDING", limit: 50 }).then((r) => r.items) : [],
    workspaceId
      ? prisma.fixProposal
          .count({
            where: {
              finding: { workspaceId, deletedAt: null },
              status: { in: ["draft", "pending"] },
              deletedAt: null,
            },
          })
          .then((count) => count > 0)
      : false,
  ])

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Approval Centre</h1>
        <p className="text-muted-foreground text-sm">
          Review and approve agent actions and fix proposals before they are applied.
        </p>
      </div>

      {!workspaceId ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No workspace yet"
          description="Create a workspace during onboarding to view approvals."
        />
      ) : (
        <ApprovalsClient workspaceId={workspaceId} approvals={approvals} hasProposals={hasProposals} />
      )}
    </div>
  )
}
