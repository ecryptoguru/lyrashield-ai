import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

export async function handleStatus(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, { boolean: ["watch"] })
  const [scanId] = parsed._
  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

  if (scanId) {
    const res = await client.request(
      "GET",
      `/scans/${scanId}?workspaceId=${encodeURIComponent(workspaceId)}`
    )
    output.result(res)
    if (parsed.watch) output.warn("--watch not yet implemented")
    return 0
  }

  const res = await client.request(
    "GET",
    `/scans?workspaceId=${encodeURIComponent(workspaceId)}`
  )
  output.result(res)
  if (parsed.watch) output.warn("--watch not yet implemented")
  return 0
}
