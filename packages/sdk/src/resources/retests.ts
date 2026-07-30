import type { LyraShieldClient } from "../client"

export interface CreateRetestInput {
  workspaceId?: string
}

export function createRetest(client: LyraShieldClient, findingId: string, input: CreateRetestInput = {}) {
  const body = {
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", `/findings/${encodeURIComponent(findingId)}/retests`, { body })
}
