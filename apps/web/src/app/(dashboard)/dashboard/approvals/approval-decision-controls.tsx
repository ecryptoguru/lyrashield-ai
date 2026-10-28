"use client"

import { useEffect, useState } from "react"
import { Button } from "@lyrashield/ui"
import { Check, X } from "lucide-react"
import type { ApprovalListItem } from "@lyrashield/db"
import { InlineConfirm } from "@/components/ui/inline-confirm"

export function ApprovalDecisionControls({
  approval,
  canDecide,
  canApproveFix,
  pending,
  onDeny,
  onApprove,
}: {
  approval: Pick<ApprovalListItem, "actionName" | "expiresAt">
  canDecide: boolean
  canApproveFix: boolean
  pending: boolean
  onDeny: () => void
  onApprove: () => void
}) {
  const expiresAt = approval.expiresAt ? new Date(approval.expiresAt).getTime() : null
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (expiresAt === null || !Number.isFinite(expiresAt) || expiresAt <= now) return
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.max(0, expiresAt - Date.now()), 2_147_483_647)
    )
    return () => clearTimeout(timer)
  }, [expiresAt, now])
  const isExpired = () =>
    expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now))
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Request expired. Request a new approval from the proposed fix.
      </p>
    )
  return canDecide ? (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          if (!isExpired()) onDeny()
        }}
        disabled={pending}
      >
        <X className="size-4" />
        Deny
      </Button>
      {approval.actionName === "fix_pr.open" && !canApproveFix && (
        <p className="text-muted-foreground text-sm">
          Ask an authorized workspace member to approve this fix.
        </p>
      )}
      {(approval.actionName !== "fix_pr.open" || canApproveFix) && (
        <InlineConfirm
          triggerLabel="Approve"
          triggerIcon={<Check className="size-4" />}
          disabled={pending}
          message="Approve this exact action input?"
          confirmLabel="Approve action"
          onConfirm={() => {
            if (!isExpired()) onApprove()
          }}
        />
      )}
    </div>
  ) : (
    <p className="text-muted-foreground text-sm">
      Ask an authorized workspace member to review this request.
    </p>
  )
}
