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
