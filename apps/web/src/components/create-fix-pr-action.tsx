"use client"

import { useState } from "react"
import Link from "next/link"
import { z } from "zod"
import { Button } from "@lyrashield/ui"
import { ApiError, apiGet, apiPost } from "@/lib/api-client"
import { InlineConfirm } from "@/components/ui/inline-confirm"

const outcomeSchema = z
  .object({
    status: z.enum([
      "ready",
      "pending_approval",
      "opening",
      "opened",
      "closed",
      "merged",
      "expired",
      "stale",
      "recovery_required",
      "rejected",
      "failed",
    ]),
    approvalId: z.string().min(1).optional(),
    prNumber: z.number().int().positive().optional(),
    prUrl: z.string().url().optional(),
    reason: z.string().optional(),
  })
  .superRefine((outcome, ctx) => {
    if (outcome.status === "opened" && (!outcome.prNumber || !outcome.prUrl))
      ctx.addIssue({ code: "custom", message: "Opened PR must include its number and URL" })
    if (outcome.status === "pending_approval" && !outcome.approvalId)
      ctx.addIssue({ code: "custom", message: "Pending approval must include its ID" })
  })
type Outcome = z.infer<typeof outcomeSchema>

export function CreateFixPrAction({
  workspaceId,
  proposalId,
  prominent = false,
  hasExecution = false,
}: {
  workspaceId: string
  proposalId: string
  prominent?: boolean
  hasExecution?: boolean
}) {
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(
    hasExecution ? { status: "opening" } : null
  )
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<"inactive" | "stale" | null>(null)
  const endpoint = `/api/fix-proposals/${encodeURIComponent(proposalId)}/create-pr`
  async function submit(checkStatus = false) {
    setPending(true)
    setError(null)
    setBlocked(null)
    try {
      const result = checkStatus
        ? await apiGet(
            `${endpoint}?${new URLSearchParams({ workspaceId, ...(outcome?.approvalId ? { approvalId: outcome.approvalId } : {}) })}`,
            { schema: outcomeSchema }
          )
        : await apiPost(endpoint, { workspaceId }, { schema: outcomeSchema })
      setOutcome(result)
    } catch (error) {
      if (error instanceof ApiError) {
        if (["GITHUB_CONNECTION_INACTIVE", "NO_REPOSITORY_LINK"].includes(error.code))
          setBlocked("inactive")
        if (
          [
            "INPUT_HASH_MISMATCH",
            "NO_BASE_COMMIT",
            "PROPOSAL_PATCH_PROVENANCE_REQUIRED",
            "PROPOSAL_PATCH_UNAVAILABLE",
          ].includes(error.code)
        )
          setBlocked("stale")
      }
      setError(error instanceof Error ? error.message : "Unable to check pull request state")
    } finally {
      setPending(false)
    }
  }
  const canRequest =
    !blocked &&
    (!outcome || ["ready", "expired", "stale", "rejected", "failed"].includes(outcome.status))
  return (
    <div className="space-y-2">
      {outcome && (
        <p role="status" className="text-sm wrap-break-word">
          {outcome.status === "ready" && "The stored patch is ready to request approval."}
          {outcome.status === "pending_approval" && (
            <>
              Approval {outcome.approvalId} is awaiting review by an authorized workspace member.{" "}
              <Link href="/dashboard/approvals" className="text-primary underline">
                View approval
              </Link>
            </>
          )}
          {outcome.status === "opening" &&
            "Pull request execution is pending or opening. Check status to confirm the GitHub outcome."}
          {outcome.status === "opened" && (
            <>
              Pull request #{outcome.prNumber} is open.{" "}
              <a
                href={outcome.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                View pull request
              </a>
            </>
          )}
          {outcome.status === "closed" &&
            "This pull request was closed. It will not be reopened automatically."}
          {outcome.status === "merged" &&
            "This pull request was merged. Review the retest receipt before treating the finding as fixed."}
          {outcome.status === "expired" &&
            "Approval expired. Request a new approval for this stored patch."}
          {outcome.status === "stale" &&
            "This approval no longer matches the patch. Request a new approval."}
          {outcome.status === "recovery_required" &&
            "This pull request needs recovery. Check status to reconcile GitHub; uncertain writes will not be repeated."}
          {["rejected", "failed"].includes(outcome.status) &&
            (outcome.reason ?? "The pull request could not be opened.")}
        </p>
      )}
      {blocked && (
        <p role="status" className="text-sm">
          {blocked === "inactive"
            ? "The GitHub connection is inactive. Reconnect the repository, then check status."
            : "The stored patch is stale or unavailable. Generate a new proposal before requesting approval."}
        </p>
      )}
      {canRequest && (
        <InlineConfirm
          triggerVariant={prominent ? "outline" : "ghost"}
          triggerLabel={pending ? "Requesting approval…" : "Create pull request"}
          disabled={pending}
          message="Request approval for the stored patch? Your code changes only after approval."
          confirmLabel="Request approval"
          onConfirm={() => submit()}
        />
      )}
      {(outcome || blocked || error) && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => submit(true)}
        >
          {pending ? "Checking…" : "Check PR status"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  )
}
