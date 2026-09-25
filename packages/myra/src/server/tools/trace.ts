/**
 * attach_trace — bind a message traceId from the caller's own conversation
 * into a pending case draft's payload. An already previewed case is replaced
 * atomically, so confirmation always refers to the details shown to the user.
 */
import { z } from "zod"
import { MYRA_COPY, submitCasePayloadSchema } from "../../contracts"
import { createProposal, hashOperationPayload } from "../operations"
import { err } from "../errors"
import { ownerWhere, withOwnerScope } from "../db"
import { casePreview, toProposalSummary } from "./cases"
import type { MyraToolContext, MyraToolResult } from "./types"

export const attachTraceInput = z.object({ traceId: z.string().min(4).max(80) })

export async function runAttachTrace(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const { traceId } = attachTraceInput.parse(input)

  return withOwnerScope(
    ctx.principal,
    async (tx) => {
      // The trace must belong to a conversation the principal owns.
      const message = await tx.myraMessage.findFirst({
        where: {
          traceId,
          conversation: {
            ...ownerWhere(ctx.principal),
            ...(ctx.conversationId ? { id: ctx.conversationId } : {}),
          },
        },
        select: { id: true },
      })
      if (!message) throw err("NOT_FOUND", "Trace not found.")

      // Attach to the conversation's open case-draft proposal, if one exists.
      const proposal = ctx.conversationId
        ? await tx.myraOperation.findFirst({
            where: {
              conversationId: ctx.conversationId,
              operationName: "submit_support_case",
              status: { in: ["DRAFT", "AWAITING_CONFIRMATION"] },
              ...ownerWhere(ctx.principal),
            },
            orderBy: { createdAt: "desc" },
          })
        : null

      let attached = false
      let proposalId: string | null = null
      let replacement: Awaited<ReturnType<typeof createProposal>> | null = null
      let previewPayload: ReturnType<typeof submitCasePayloadSchema.parse> | null = null
      if (proposal) {
        const payload = { ...(proposal.payload as Record<string, unknown>), traceId }
        if (proposal.status === "DRAFT") {
          const changed = await tx.myraOperation.updateMany({
            where: { id: proposal.id, status: "DRAFT" },
            data: { payload, inputHash: hashOperationPayload(payload) },
          })
          attached = changed.count === 1
          proposalId = attached ? proposal.id : null
        } else {
          const casePayload: Record<string, unknown> = { ...payload }
          delete casePayload.traceId
          previewPayload = submitCasePayloadSchema.parse(casePayload)
          if (!previewPayload.replyEmail) {
            throw err("PROPOSAL_PAYLOAD_CHANGED", "Ask Myra to prepare this case again.")
          }
          const changed = await tx.myraOperation.updateMany({
            where: { id: proposal.id, status: "AWAITING_CONFIRMATION" },
            data: { status: "CANCELED" },
          })
          if (changed.count === 1) {
            replacement = await createProposal(
              {
                principal: ctx.principal,
                conversationId: ctx.conversationId,
                workspaceId: ctx.workspaceId,
              },
              "submit_support_case",
              payload,
              { db: tx }
            )
            attached = true
            proposalId = replacement.id
          }
        }
      }

      const summary =
        replacement && previewPayload
          ? toProposalSummary(replacement, "Send support request", MYRA_COPY.caseDraft, {
              subject: previewPayload.subject,
              includeDiagnostics: previewPayload.includeDiagnostics,
              traceId,
            })
          : null

      return {
        data: { traceId, attached, proposalId },
        components: [
          { type: "trace_ref", traceId },
          ...(summary && previewPayload
            ? [casePreview(summary, previewPayload, previewPayload.replyEmail!)]
            : []),
        ] as MyraToolResult["components"],
        ...(summary ? { proposals: [summary] } : {}),
      }
    },
    ctx.db
  )
}
