import type { LyraShieldClient } from "../client"
import { z } from "zod"
import { RetestCreatedSchema } from "../schemas"

export interface CreateRetestInput {
  workspaceId?: string
}

export function createRetest(
  client: LyraShieldClient,
  findingId: string,
  input: CreateRetestInput = {}
): Promise<z.infer<typeof RetestCreatedSchema>> {
  const body = {
    workspaceId: input.workspaceId ?? client.workspaceId,
  }
  return client.request("POST", `/findings/${encodeURIComponent(findingId)}/retests`, {
    body,
    parse: (data) => RetestCreatedSchema.parse(data),
  })
}
