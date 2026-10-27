"use client"

import { useState } from "react"
import Link from "next/link"
import { z } from "zod"
import { apiPost } from "@/lib/api-client"
import { InlineConfirm } from "@/components/ui/inline-confirm"

export function CreateFixPrAction({
  workspaceId,
  proposalId,
  prominent = false,
}: {
  workspaceId: string
  proposalId: string
  prominent?: boolean
}) {
  const [pending, setPending] = useState(false)
  const [approvalId, setApprovalId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function requestApproval() {
    setPending(true)
    setError(null)
    try {
      const result = await apiPost(
        `/api/fix-proposals/${encodeURIComponent(proposalId)}/create-pr`,
        { workspaceId },
        {
          schema: z.object({
            status: z.literal("pending_approval"),
            approvalId: z.string().min(1),
          }),
        }
      )
      setApprovalId(result.approvalId)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to request pull request approval")
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="space-y-2">
      {approvalId ? (
        <p role="status">
          Approval {approvalId} is awaiting review by an authorized workspace member.{" "}
          <Link href="/dashboard/approvals" className="text-primary underline">
            View approval
          </Link>
        </p>
      ) : (
        <InlineConfirm
          triggerVariant={prominent ? "outline" : "ghost"}
          triggerLabel={pending ? "Requesting approval…" : "Create pull request"}
          disabled={pending}
          message="Request approval for the stored patch? Your code changes only after approval."
          confirmLabel="Request approval"
          onConfirm={requestApproval}
        />
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  )
}
