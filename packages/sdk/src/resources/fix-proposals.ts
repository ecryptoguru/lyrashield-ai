import type { LyraShieldClient } from "../client"
import { z } from "zod"
import { IdSchema } from "../schemas"

export interface CreateFixProposalInput {
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
    ...input,
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", `/findings/${encodeURIComponent(findingId)}/fix-proposals`, {
    body,
    parse: (data) => IdSchema.parse(data),
  })
}
