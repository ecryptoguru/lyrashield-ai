import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

export async function handleStatus(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, { boolean: ["watch"] })
  const [scanId] = parsed._

  // Fail before doing work rather than printing a result and exiting 0, which
  // would let a script believe it had followed the scan to completion.
  if (parsed.watch) {
    output.error(
      "--watch is not implemented yet. Re-run without --watch, or poll periodically: lyrashield status <scanId>"
    )
    return 2
  }

  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

  if (scanId) {
    const res = await client.request(
      "GET",
      `/scans/${scanId}?workspaceId=${encodeURIComponent(workspaceId)}`
    )
    output.result(res)
    return 0
  }

  const res = await client.request("GET", `/scans?workspaceId=${encodeURIComponent(workspaceId)}`)
  output.result(res)
  return 0
}
