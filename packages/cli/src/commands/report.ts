import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

export async function handleReport(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, { string: ["scan", "title", "type"] })
  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

  if (parsed.title) {
    const res = await client.request("POST", "/api/v1/reports", {
      body: {
        workspaceId,
        scanId: parsed.scan,
        title: parsed.title,
        type: parsed.type ?? "developer",
      },
    })
    output.result(res)
  } else {
    const res = await client.request(
      "GET",
      `/api/v1/reports?workspaceId=${encodeURIComponent(workspaceId)}`
    )
    output.result(res)
  }

  return 0
}
