import type { LyraShieldClient } from "../client"
import { z } from "zod"
import { WorkspaceListSchema } from "../schemas"

export function listWorkspaces(
  client: LyraShieldClient
): Promise<z.infer<typeof WorkspaceListSchema>> {
  return client.request("GET", "/workspaces", {
    parse: (data) => WorkspaceListSchema.parse(data),
  })
}
