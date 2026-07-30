import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

export async function handleTargets(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, { string: ["name", "type", "url", "repo"] })
  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

  if (parsed.name) {
    const body: Record<string, unknown> = {
      workspaceId,
      name: parsed.name,
      type: parsed.type ?? "repo",
    }
    if (parsed.url) body.url = parsed.url
    if (parsed.repo) body.repository = parsed.repo
    const res = await client.request("POST", "/api/v1/targets", { body })
    output.result(res)
  } else {
    const res = await client.request(
      "GET",
      `/api/v1/targets?workspaceId=${encodeURIComponent(workspaceId)}`
    )
    output.result(res)
  }

  return 0
}
