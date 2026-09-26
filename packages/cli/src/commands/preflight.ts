import minimist from "minimist"
import { getScanEligibility, type ScanEligibilityInput } from "@lyrashield/sdk"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

const GOALS = new Set([
  "CHECK_PR",
  "TEST_APP",
  "LAUNCH_REVIEW",
  "WEEKLY_MONITOR",
  "FULL_PENTEST",
  "COMPLIANCE_REVIEW",
])
const MODES = new Set(["SAFE", "QUICK", "STANDARD", "DEEP", "CUSTOM"])
const WORKFLOWS = new Set(["REVIEW_TARGET", "REVIEW_CHANGES", "AUTHENTICATED_ASSESSMENT"])

export async function handlePreflight(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: [
      "target",
      "goal",
      "mode",
      "workflow",
      "base",
      "head",
      "attachment",
      "authorization-ref",
    ],
    default: { goal: "TEST_APP", mode: "STANDARD" },
  })
  const targetId = parsed.target as string | undefined
  const goal = String(parsed.goal).toUpperCase()
  const mode = String(parsed.mode).toUpperCase()
  const workflow = parsed.workflow ? String(parsed.workflow).toUpperCase() : undefined
  const attachmentArgs = parsed.attachment as string | string[] | undefined
  const attachmentIds =
    attachmentArgs === undefined
      ? []
      : Array.isArray(attachmentArgs)
        ? attachmentArgs
        : [attachmentArgs]

  if (!targetId || !GOALS.has(goal) || !MODES.has(mode) || (workflow && !WORKFLOWS.has(workflow))) {
    output.error(
      "Usage: lyrashield preflight --target <id> [--goal GOAL] [--mode MODE] [--workflow WORKFLOW]"
    )
    return 2
  }
  if (attachmentIds.some((id) => !id || typeof id !== "string") || attachmentIds.length > 20) {
    output.error("--attachment requires 1-20 non-empty attachment IDs")
    return 2
  }
  if ((parsed.base || parsed.head) && workflow !== "REVIEW_CHANGES") {
    output.error("--base/--head require --workflow REVIEW_CHANGES")
    return 2
  }
  if (workflow === "REVIEW_CHANGES" && !parsed.base) {
    output.error("REVIEW_CHANGES requires --base")
    return 2
  }
  if (
    (parsed["authorization-ref"] && workflow !== "AUTHENTICATED_ASSESSMENT") ||
    (workflow === "AUTHENTICATED_ASSESSMENT" && !parsed["authorization-ref"])
  ) {
    output.error("AUTHENTICATED_ASSESSMENT requires --authorization-ref")
    return 2
  }

  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()
  const input: ScanEligibilityInput = {
    workspaceId,
    targetId,
    goal,
    mode,
    ...(workflow ? { workflow: workflow as ScanEligibilityInput["workflow"] } : {}),
    ...(parsed.base ? { baseRef: parsed.base as string } : {}),
    ...(parsed.head ? { headRef: parsed.head as string } : {}),
    ...(attachmentIds.length ? { attachmentIds } : {}),
    ...(parsed["authorization-ref"]
      ? { authorizationRef: parsed["authorization-ref"] as string }
      : {}),
  }
  const result = await getScanEligibility(client, input)
  output.result(result)
  return result.allowed ? 0 : 1
}
