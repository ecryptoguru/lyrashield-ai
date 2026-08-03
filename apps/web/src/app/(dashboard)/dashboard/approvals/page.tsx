import { getCachedSession, getCachedWorkspaceId, getCachedWorkspaces } from "@/lib/cache"
import { listApprovals, prisma } from "@lyrashield/db"
import type { MemberRole } from "@lyrashield/db"
import { REVIEW_QUEUE_LABEL, APPROVAL_PLURAL } from "@/lib/terminology"
import { ClipboardCheck, ShieldX } from "lucide-react"
import { EmptyState } from "@lyrashield/ui"
import { ApprovalsClient } from "./approvals-client"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { hasPermission, PERMISSIONS } from "@lyrashield/auth"

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
          title={REVIEW_QUEUE_LABEL}
          description="Review and approve agent actions and fix proposals before they are applied."
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
          title={REVIEW_QUEUE_LABEL}
          description="Review and approve agent actions and fix proposals before they are applied."
        />
        <EmptyState
          icon={ShieldX}
          title="Access restricted"
          description="You do not have permission to view the Review Queue."
          action={null}
        />
      </div>
    )
  }

  const [approvals, hasProposals] = await Promise.all([
    workspaceId
      ? listApprovals({ workspaceId, status: "PENDING", limit: 50 }).then((r) => r.items)
      : [],
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
    <div>
      <PageHeader
        title={REVIEW_QUEUE_LABEL}
        description="Review and approve agent actions and fix proposals before they are applied."
      />

      <ApprovalsClient
        workspaceId={workspaceId}
        approvals={approvals}
        hasProposals={hasProposals}
      />
    </div>
  )
}
