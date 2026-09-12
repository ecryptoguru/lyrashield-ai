"use client"

import { useCallback, useState } from "react"
import { Button, Card, CardContent, Badge } from "@lyrashield/ui"
import { Check, X, ShieldCheck, AlertCircle, Activity } from "lucide-react"
import Link from "next/link"
import { apiPost } from "@/lib/api-client"
import { type ApprovalListItem } from "@lyrashield/db"
import { InlineConfirm } from "@/components/ui/inline-confirm"
import { formatDateTime } from "@/lib/date-format"
import type { AgentOperationListItem } from "@lyrashield/db"

interface ApprovalItem extends Omit<ApprovalListItem, "input"> {
  input: Record<string, unknown>
}

const OPERATION_STATUS_VARIANT: Record<
  string,
  "success" | "danger" | "warning" | "info" | "muted"
> = {
  COMPLETED: "success",
  FAILED: "danger",
  CONFLICT: "warning",
  EXECUTING: "info",
  PENDING: "muted",
}

/** Human action label for a recorded operation ("report.create" -> "Report created"). */
function operationLabel(operationName: string): string {
  const verb: Record<string, string> = {
    "scan.create": "Scan started",
    "report.create": "Report created",
    "fix_proposal.create": "Fix proposal created",
    "retest.create": "Retest started",
    "fix_pr.create": "Fix PR opened",
  }
  if (verb[operationName]) return verb[operationName]!
  const label = operationName.replace(/[._-]/g, " ").trim()
  if (!label) return "Operation"
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/**
 * Where a completed operation's result is visible in the dashboard, or null
 * when the result has no page (some results are only API payloads). The
 * reference itself is a bare id — never shown raw when a link can stand in.
 */
function operationResultHref(operation: AgentOperationListItem): string | null {
  if (!operation.resultReference || operation.status !== "COMPLETED") return null
  switch (operation.operationName) {
    case "scan.create":
      return `/dashboard/scans/${operation.resultReference}`
    case "report.create":
      return "/dashboard/reports"
    case "fix_proposal.create":
      return "/dashboard/findings?tab=fixes"
    case "retest.create":
      return "/dashboard/findings"
    default:
      return null
  }
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
  /** Recent durable operations (W1-09): status, result, and recovery. */
  operations?: AgentOperationListItem[]
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

export function ApprovalsClient({
  workspaceId,
  approvals,
  hasProposals,
  operations = [],
}: ApprovalsClientProps) {
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

  if (items.length === 0 && !hasProposals && !notice && operations.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-12 text-center">
        <Activity className="text-muted-foreground mx-auto size-10" />
        <h2 className="mt-4 text-lg font-semibold">No operation activity yet</h2>
        <p className="text-muted-foreground text-sm">
          Automated operations and any legacy approvals will appear here.
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
      {operations.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold tracking-tight">Operation activity</h2>
          <p className="text-muted-foreground text-sm">
            Authorized operations run automatically within their grant. Failed or conflicting
            operations show their recovery here — retrying with the same idempotency key never
            duplicates a completed action.
          </p>
          <ul className="mt-3 grid gap-2" aria-label="Recent operations">
            {operations.map((operation) => {
              const resultHref = operationResultHref(operation)
              return (
                <li key={operation.id}>
                  <Card>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div className="min-w-0 flex-1 basis-64">
                        <p className="text-xs font-medium tracking-wide uppercase">
                          {operationLabel(operation.operationName)}
                        </p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {formatDateTime(operation.createdAt)}
                          {operation.error ? ` · ${operation.error}` : ""}
                          {resultHref ? (
                            <>
                              {" · "}
                              <Link
                                href={resultHref}
                                className="text-primary font-medium hover:underline"
                              >
                                Open result
                              </Link>
                            </>
                          ) : operation.resultReference ? (
                            " · result recorded"
                          ) : (
                            ""
                          )}
                        </p>
                      </div>
                      <Badge variant={OPERATION_STATUS_VARIANT[operation.status] ?? "muted"}>
                        {operation.status.replaceAll("_", " ").toLowerCase()}
                      </Badge>
                    </CardContent>
                  </Card>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {items.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold tracking-tight">Legacy approvals</h2>
          <p className="text-muted-foreground text-sm">
            These came from credentials created before automatic authorization. New connections do
            not create these; approve or deny each exact input below.
          </p>
          <div className="mt-3 grid gap-3">
            {items.map((approval) => (
              <Card
                key={approval.id}
                id={`approval-${approval.id}`}
                className="min-w-0 scroll-mt-6"
              >
                <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="text-xs font-medium tracking-wide uppercase">
                      {operationLabel(approval.actionName)}
                    </p>
                    <p className="mt-1 wrap-break-word font-medium">
                      {approvalSummary(approval.actionName, approval.input)}
                    </p>
                    <details className="mt-3 min-w-0 max-w-full rounded border p-3">
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
                            <dd className="min-w-0 max-w-full">
                              <pre className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
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
                  <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
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
              Open a finding to review or apply its generated proposed fix.
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
