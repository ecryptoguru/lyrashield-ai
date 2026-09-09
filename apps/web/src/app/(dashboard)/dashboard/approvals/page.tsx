import type { Metadata } from "next"
import { getCachedSession, getCachedWorkspaceId, getCachedWorkspaces } from "@/lib/cache"
import { listApprovals, listRecentAgentOperations, withWorkspaceRLS } from "@lyrashield/db"
import type { MemberRole } from "@lyrashield/db"
import { APPROVAL_PLURAL } from "@/lib/terminology"
import { ClipboardCheck, ShieldX } from "lucide-react"
import { EmptyState } from "@lyrashield/ui"
import { ApprovalsClient } from "./approvals-client"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { hasPermission, PERMISSIONS } from "@lyrashield/auth"

export const metadata: Metadata = {
  title: "Activity",
}

export default async function ApprovalsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  const workspaces = await getCachedWorkspaces(session.userId)
  const active = workspaceId ? workspaces.find((w) => w.id === workspaceId) : null
  const canView = active ? hasPermission(active.role as MemberRole, PERMISSIONS.agent.view) : false

  if (!workspaceId) {
    return (
      <div>
        <PageHeader
          title="Activity"
          description="Operation activity and recovery, plus any legacy approvals that still need a decision."
        />
        <NoWorkspaceState
          icon={ClipboardCheck}
          description={`Create a workspace during onboarding to view ${APPROVAL_PLURAL.toLowerCase()}.`}
        />
      </div>
    )
  }

  if (!canView) {
    return (
      <div>
        <PageHeader
          title="Activity"
          description="Operation activity and recovery for authorized workflows."
        />
        <EmptyState
          icon={ShieldX}
          title="Access restricted"
          description="You do not have permission to view operation activity for this workspace."
          action={null}
        />
      </div>
    )
  }

  const [approvals, hasProposals, operations] = await Promise.all([
    workspaceId
      ? listApprovals({ workspaceId, status: "PENDING", limit: 50 }).then((r) => r.items)
      : [],
    workspaceId
      ? withWorkspaceRLS(workspaceId, (tx) =>
          tx.fixProposal.count({
            where: {
              finding: { workspaceId, deletedAt: null },
              status: { in: ["draft", "pending", "ready"] },
              deletedAt: null,
            },
          })
        ).then((count) => count > 0)
      : false,
    listRecentAgentOperations(workspaceId, 20),
  ])

  return (
    <div>
      <PageHeader
        title="Activity"
        description="What automated operations did, what needs recovery, and any legacy approvals that still require a decision."
      />

      <ApprovalsClient
        workspaceId={workspaceId}
        approvals={approvals}
        hasProposals={hasProposals}
        operations={operations}
      />
    </div>
  )
}
