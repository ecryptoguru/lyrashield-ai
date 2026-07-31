import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

const VALID_GOALS = [
  "CHECK_PR",
  "TEST_APP",
  "LAUNCH_REVIEW",
  "WEEKLY_MONITOR",
  "FULL_PENTEST",
  "COMPLIANCE_REVIEW",
]
const VALID_MODES = ["SAFE", "QUICK", "STANDARD", "DEEP", "CUSTOM"]

export async function handleScan(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: ["target", "goal", "mode"],
    boolean: ["watch"],
    default: { goal: "TEST_APP", mode: "SAFE" },
  })

  const [targetId] = parsed._
  const resolvedTarget = (parsed.target as string) ?? targetId
  if (!resolvedTarget) {
    output.error("usage: lyrashield scan --target <targetId> [--goal ...] [--mode ...]")
    return 2
  }

  const goal = (parsed.goal as string).toUpperCase()
  if (!VALID_GOALS.includes(goal)) {
    output.error(`Invalid goal. Choose: ${VALID_GOALS.join(", ")}`)
    return 2
  }

  const mode = (parsed.mode as string).toUpperCase()
  if (!VALID_MODES.includes(mode)) {
    output.error(`Invalid mode. Choose: ${VALID_MODES.join(", ")}`)
    return 2
  }

  const client = await createClient()
  const workspaceId = requireWorkspace(await getEffectiveCredentials())

  const res = (await client.request("POST", "/scans", {
    body: { workspaceId, targetId: resolvedTarget, goal, mode },
  })) as { id: string }

  output.result(res)

  if (parsed.watch) {
    // placeholder: the SDK resource would poll with ETag
    output.warn("--watch not yet implemented")
  }

  return 0
}
