/**
 * attach_trace — bind a message traceId from the caller's own conversation
 * into a pending case draft's payload. Read-only for messages; the draft
 * payload change recomputes the input hash, so a fresh confirmation is
 * required.
 */
import { z } from "zod"
import { hashOperationPayload } from "../operations"
import { err } from "../errors"
import { ownerWhere, withOwnerScope } from "../db"
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
      if (proposal) {
        const payload = { ...(proposal.payload as Record<string, unknown>), traceId }
        await tx.myraOperation.update({
          where: { id: proposal.id },
          data: { payload, inputHash: hashOperationPayload(payload) },
        })
        attached = true
      }

      return {
        data: { traceId, attached, proposalId: attached ? proposal!.id : null },
        components: [{ type: "trace_ref", traceId }] as MyraToolResult["components"],
      }
    },
    ctx.db
  )
}
