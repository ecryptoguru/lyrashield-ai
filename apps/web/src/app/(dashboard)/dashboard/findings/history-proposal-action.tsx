"use client"

import { CreateFixPrAction } from "@/components/create-fix-pr-action"
import type { FindingDetail } from "./finding-detail-drawer"

export function HistoryProposalAction({
  proposal,
  findingStatus,
  canCreatePr,
  workspaceId,
}: {
  proposal: NonNullable<FindingDetail["fixProposals"]>[number]
  findingStatus: string
  canCreatePr: boolean
  workspaceId: string
}) {
  if (
    !canCreatePr ||
    !proposal.hasStoredPatch ||
    !(
      proposal.status === "ready" ||
      (findingStatus === "FIX_READY" && ["draft", "approved"].includes(proposal.status))
    )
  )
    return null
  return (
    <CreateFixPrAction
      workspaceId={workspaceId}
      proposalId={proposal.id}
      hasExecution={Boolean(proposal.pullRequests?.length)}
    />
  )
}
