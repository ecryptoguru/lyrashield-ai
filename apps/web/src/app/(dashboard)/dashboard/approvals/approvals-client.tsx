"use client"

import { useCallback, useState } from "react"
import { Button, Card, CardContent } from "@lyrashield/ui"
import { Check, X, ShieldCheck, ClipboardList, AlertCircle } from "lucide-react"
import { apiPost } from "@/lib/api-client"
import { type ApprovalListItem } from "@lyrashield/db"

interface ApprovalItem extends Omit<ApprovalListItem, "input"> {
  input: Record<string, unknown>
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

export interface ApprovalsClientProps {
  workspaceId: string
  approvals: ApprovalListItem[]
  hasProposals: boolean
}

function toApprovalItem(approval: ApprovalListItem): ApprovalItem {
  return {
    ...approval,
    input: asObject(approval.input),
  }
}

function approvalSummary(actionName: string, input: Record<string, unknown>): string {
  const title = input.title ?? input.findingTitle ?? input.targetName
  if (typeof title === "string") return title as string
  const actionLabel = actionName.replace(/[-_]/g, " ")
  return actionLabel.charAt(0).toUpperCase() + actionLabel.slice(1)
}

export function ApprovalsClient({ workspaceId, approvals, hasProposals }: ApprovalsClientProps) {
  const [items, setItems] = useState(() => approvals.map(toApprovalItem))
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)

  const handleApprove = useCallback(
    async (approval: ApprovalItem) => {
      setError(null)
      setPending((prev) => ({ ...prev, [approval.id]: true }))
      try {
        await apiPost(`/api/agent-approvals/${approval.id}/approve`, {
          workspaceId,
          input: approval.input,
        })
        setItems((prev) => prev.filter((i) => i.id !== approval.id))
      } catch (err) {
        console.error("Failed to approve", err)
        setError(err instanceof Error ? err.message : "Approval failed")
      } finally {
        setPending((prev) => ({ ...prev, [approval.id]: false }))
      }
    },
    [workspaceId]
  )

  const handleDeny = useCallback(
    async (approval: ApprovalItem) => {
      setError(null)
      setPending((prev) => ({ ...prev, [approval.id]: true }))
      try {
        await apiPost(`/api/agent-approvals/${approval.id}/deny`, { workspaceId })
        setItems((prev) => prev.filter((i) => i.id !== approval.id))
      } catch (err) {
        console.error("Failed to deny", err)
        setError(err instanceof Error ? err.message : "Deny failed")
      } finally {
        setPending((prev) => ({ ...prev, [approval.id]: false }))
      }
    },
    [workspaceId]
  )

  if (items.length === 0 && !hasProposals) {
    return (
      <div className="rounded-xl border border-dashed p-12 text-center">
        <ClipboardList className="text-muted-foreground mx-auto size-10" />
        <h2 className="mt-4 text-lg font-semibold">No pending approvals</h2>
        <p className="text-muted-foreground text-sm">
          Agent actions that require approval will appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error && (
        <div
          className="bg-destructive/5 border-destructive/20 rounded-lg border p-4"
          role="alert"
        >
          <div className="text-destructive flex items-center gap-2 text-sm font-medium">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </div>
        </div>
      )}
      {items.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold tracking-tight">Agent actions</h2>
          <p className="text-muted-foreground text-sm">
            Review and approve actions requested by the agent before they run.
          </p>
          <div className="mt-3 grid gap-3">
            {items.map((approval) => (
              <Card key={approval.id}>
                <CardContent className="flex items-start justify-between gap-4 p-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {approval.actionName}
                    </p>
                    <p className="mt-1 font-medium">{approvalSummary(approval.actionName, approval.input)}</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Expires {approval.expiresAt ? new Date(approval.expiresAt).toLocaleDateString() : "Never"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDeny(approval)}
                      disabled={pending[approval.id]}
                    >
                      <X className="size-4" />
                      Deny
                    </Button>
                    <Button size="sm" onClick={() => handleApprove(approval)} disabled={pending[approval.id]}>
                      <Check className="size-4" />
                      Approve
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {hasProposals && (
        <section>
          <h2 className="text-lg font-semibold tracking-tight">Fix proposals</h2>
          <p className="text-muted-foreground text-sm">
            Proposed code changes generated by the engine remain linked from the finding page.
          </p>
          <div className="mt-3 rounded-lg border border-dashed p-8 text-center">
            <ShieldCheck className="text-muted-foreground mx-auto size-8" />
            <p className="text-muted-foreground mt-2 text-sm">
              Open a finding to review or apply its generated fix proposal.
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
