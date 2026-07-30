import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

export async function handleFixPlan(args: string[], output: Output): Promise<number> {
  const [findingId] = args
  if (!findingId) {
    output.error("usage: lyrashield fix-plan <findingId>")
    return 2
  }
  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()
  const res = await client.request("POST", `/api/v1/findings/${findingId}/fix-proposals`, {
    body: { workspaceId },
  })
  output.result(res)
  return 0
}
