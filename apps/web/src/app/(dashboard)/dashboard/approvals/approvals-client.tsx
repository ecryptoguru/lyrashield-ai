"use client"

import { useCallback, useState } from "react"
import { Button, Card, CardContent } from "@lyrashield/ui"
import { Check, X, ShieldCheck, ClipboardList, AlertCircle } from "lucide-react"
import { apiPost } from "@/lib/api-client"
import { type ApprovalListItem } from "@lyrashield/db"
import { InlineConfirm } from "@/components/ui/inline-confirm"

interface ApprovalItem extends Omit<ApprovalListItem, "input"> {
  input: Record<string, unknown>
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>
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
  const [notice, setNotice] = useState<string | null>(null)

  const handleApprove = useCallback(
    async (approval: ApprovalItem) => {
      setError(null)
      setPending((prev) => ({ ...prev, [approval.id]: true }))
      try {
        const result = await apiPost<{ execution?: { status: string; prNumber?: number } }>(
          `/api/agent-approvals/${approval.id}/approve`,
          {
            workspaceId,
            input: approval.input,
          }
        )
        setNotice(
          result.execution?.status === "opened"
            ? `Pull request #${result.execution.prNumber} opened. Review it in Proposed fixes.`
            : "Action approved."
        )
        setItems((prev) => prev.filter((i) => i.id !== approval.id))
      } catch (err) {
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
        setError(err instanceof Error ? err.message : "Deny failed")
      } finally {
        setPending((prev) => ({ ...prev, [approval.id]: false }))
      }
    },
    [workspaceId]
  )

  if (items.length === 0 && !hasProposals && !notice) {
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
      {notice && <p role="status">{notice}</p>}
      {error && (
        <div className="bg-destructive/5 border-destructive/20 rounded-lg border p-4" role="alert">
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
                <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                      {approval.actionName}
                    </p>
                    <p className="mt-1 break-words font-medium">
                      {approvalSummary(approval.actionName, approval.input)}
                    </p>
                    <details className="mt-3 rounded border p-3">
                      <summary className="cursor-pointer text-sm font-medium">
                        Review exact action input
                      </summary>
                      <p className="text-muted-foreground mt-2 text-xs">
                        Agent-supplied content is untrusted. Review every value before approving.
                      </p>
                      <dl className="mt-2 space-y-2 text-sm">
                        {Object.entries(approval.input).map(([key, value]) => (
                          <div key={key}>
                            <dt className="break-all font-medium">{key}</dt>
                            <dd>
                              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
                                {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                              </pre>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Expires{" "}
                      {approval.expiresAt
                        ? new Date(approval.expiresAt).toLocaleDateString()
                        : "Never"}
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
                    <InlineConfirm
                      triggerLabel="Approve"
                      triggerIcon={<Check className="size-4" />}
                      disabled={pending[approval.id]}
                      message="Approve this exact action input?"
                      confirmLabel="Approve action"
                      onConfirm={() => handleApprove(approval)}
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {hasProposals && (
        <section>
          <h2 className="text-lg font-semibold tracking-tight">Proposed fixes</h2>
          <p className="text-muted-foreground text-sm">
            Proposed code changes generated by the engine remain linked from the issue page.
          </p>
          <div className="mt-3 rounded-lg border border-dashed p-8 text-center">
            <ShieldCheck className="text-muted-foreground mx-auto size-8" />
            <p className="text-muted-foreground mt-2 text-sm">
              Open an issue to review or apply its generated proposed fix.
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
