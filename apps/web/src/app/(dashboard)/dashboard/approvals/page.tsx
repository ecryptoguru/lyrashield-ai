import Link from "next/link"
import { z } from "zod"
import type { Metadata } from "next"
import { getCachedSession, getCachedWorkspaceId, getCachedWorkspaces } from "@/lib/cache"
import { listApprovals, listRecentAgentOperations, withWorkspaceRLS } from "@lyrashield/db"
import type { MemberRole } from "@lyrashield/db"
import { ClipboardCheck, ShieldX } from "lucide-react"
import { EmptyState } from "@lyrashield/ui"
import { ApprovalsClient } from "./approvals-client"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { hasPermission, PERMISSIONS } from "@lyrashield/auth"

export const metadata: Metadata = {
  title: "Activity",
}

export default async function ApprovalsPage({
  searchParams,
}: { searchParams?: Promise<{ approvalsCursor?: string; operationsCursor?: string }> } = {}) {
  const query = await searchParams
  const cursorSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/)
  const approvalsCursor = cursorSchema.safeParse(query?.approvalsCursor)
  const operationsCursor = cursorSchema.safeParse(query?.operationsCursor)
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
          description="Operation activity and recovery, plus any approvals that need a decision."
        />
        <NoWorkspaceState
          icon={ClipboardCheck}
          description="Create a workspace during onboarding to view activity."
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
      ? listApprovals({
          workspaceId,
          status: "PENDING",
          limit: 50,
          ...(approvalsCursor.success ? { cursor: approvalsCursor.data } : {}),
        })
      : { items: [], nextCursor: null },
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
    listRecentAgentOperations(
      workspaceId,
      21,
      operationsCursor.success ? operationsCursor.data : undefined
    ),
  ])

  return (
    <div>
      <PageHeader
        title="Activity"
        description="What automated operations did, what needs recovery and any approvals that require a decision."
      />

      <ApprovalsClient
        workspaceId={workspaceId}
        canDecide={!!active && hasPermission(active.role as MemberRole, PERMISSIONS.agent.approve)}
        canApproveFix={
          !!active && hasPermission(active.role as MemberRole, PERMISSIONS.fix.approve)
        }
        approvals={approvals.items}
        hasProposals={hasProposals}
        operations={operations.slice(0, 20)}
      />
      <nav aria-label="Activity pages" className="mt-6 flex flex-wrap gap-4 text-sm">
        {approvals.nextCursor && (
          <Link
            className="text-primary min-h-11 inline-flex items-center underline underline-offset-4"
            href={`/dashboard/approvals?${new URLSearchParams({ approvalsCursor: approvals.nextCursor, ...(operationsCursor.success ? { operationsCursor: operationsCursor.data } : {}) })}`}
          >
            More pending approvals
          </Link>
        )}
        {operations.length > 20 && (
          <Link
            className="text-primary min-h-11 inline-flex items-center underline underline-offset-4"
            href={`/dashboard/approvals?${new URLSearchParams({ operationsCursor: operations[19]!.id, ...(approvalsCursor.success ? { approvalsCursor: approvalsCursor.data } : {}) })}`}
          >
            Older operations
          </Link>
        )}
        {(approvalsCursor.success || operationsCursor.success) && (
          <Link
            className="text-primary min-h-11 inline-flex items-center underline underline-offset-4"
            href="/dashboard/approvals"
          >
            Latest activity
          </Link>
        )}
      </nav>
    </div>
  )
}
