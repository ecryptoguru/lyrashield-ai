import type { LyraShieldClient } from "../client"

export interface CreateFixProposalInput {
  workspaceId?: string
  summary: string
  generatedByModel?: string
}

export function createFixProposal(
  client: LyraShieldClient,
  findingId: string,
  input: CreateFixProposalInput
) {
  const body = {
    ...input,
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", `/findings/${encodeURIComponent(findingId)}/fix-proposals`, {
    body,
  })
}
