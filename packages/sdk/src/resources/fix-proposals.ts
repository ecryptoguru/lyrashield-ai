import type { LyraShieldClient } from "../client"
import { z } from "zod"
import { IdSchema } from "../schemas"

export interface CreateFixProposalInput {
  idempotencyKey?: string
  workspaceId?: string
  summary: string
  generatedByModel?: string
}

export function createFixProposal(
  client: LyraShieldClient,
  findingId: string,
  input: CreateFixProposalInput
): Promise<z.infer<typeof IdSchema>> {
  const body = {
    ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== "idempotencyKey")),
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", `/findings/${encodeURIComponent(findingId)}/fix-proposals`, {
    body,
    headers: { "Idempotency-Key": input.idempotencyKey ?? crypto.randomUUID() },
    parse: (data) => IdSchema.parse(data),
  })
}

export const FixPrRequestOutcomeSchema = z.object({
  status: z.enum(["pending_approval", "opened", "rejected", "failed"]),
  approvalId: z.string().optional(),
  approvalUrl: z.string().url().optional(),
  prNumber: z.number().int().positive().optional(),
  prUrl: z.string().url().optional(),
  reason: z.string().optional(),
})

/** Request the server-owned, revision-bound patch; this never supplies a patch or PR body. */
export function requestFixPr(
  client: LyraShieldClient,
  proposalId: string,
  options: { workspaceId?: string; idempotencyKey?: string } = {}
): Promise<z.infer<typeof FixPrRequestOutcomeSchema>> {
  return client.request("POST", `/fix-proposals/${encodeURIComponent(proposalId)}/create-pr`, {
    body: { workspaceId: options.workspaceId ?? client.workspaceId },
    headers: { "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID() },
    parse: (data) => FixPrRequestOutcomeSchema.parse(data),
  })
}
