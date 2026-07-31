import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

export async function handleReadiness(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, { string: ["target"] })
  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()
  const params = new URLSearchParams({ workspaceId })
  if (parsed.target) params.set("targetId", parsed.target as string)
  const res = await client.request("GET", `/launch-readiness?${params.toString()}`)
  output.result(res)
  return 0
}
