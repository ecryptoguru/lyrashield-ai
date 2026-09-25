import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials } from "../credentials.js"
import { describeCliFailure } from "../failure.js"
import { loadDefaultProject } from "../projects.js"
import type { Output } from "../output.js"
import { getScanEligibility } from "@lyrashield/sdk"

const VALID_GOALS = [
  "CHECK_PR",
  "TEST_APP",
  "LAUNCH_REVIEW",
  "WEEKLY_MONITOR",
  "FULL_PENTEST",
  "COMPLIANCE_REVIEW",
]
const VALID_MODES = ["SAFE", "QUICK", "STANDARD", "DEEP", "CUSTOM"]
const VALID_WORKFLOWS = ["REVIEW_TARGET", "REVIEW_CHANGES", "AUTHENTICATED_ASSESSMENT"] as const

const USAGE = `usage: lyrashield preflight --target <targetId> [--goal <goal>] [--mode <mode>] [--json]
       lyrashield preflight --target <targetId> --workflow REVIEW_CHANGES --base <ref> [--head <ref>]
       --attachment <id> references an attachment already uploaded to the workspace; repeat the flag for several
       --workspace, -w <id> checks against a different workspace than the stored default`

/**
 * Advisory read-only preflight: asks the server whether POST /scans would
 * currently admit the requested review. A denial here is a successful read
 * (exit 1) — usage, auth, network, rate-limit and plan failures keep their
 * usual exit codes. The command never starts a scan, claims a trial, or
 * consumes the free-URL allowance.
 */
export async function handlePreflight(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: [
      "target",
      "goal",
      "mode",
      "workspace",
      "workflow",
      "base",
      "head",
      "attachment",
      "authorization-ref",
    ],
    boolean: ["help"],
    alias: { t: "target", g: "goal", m: "mode", w: "workspace", h: "help" },
    default: { goal: "TEST_APP", mode: "STANDARD" },
  })

  if (parsed.help) {
    output.log(USAGE)
    return 0
  }

  const creds = await getEffectiveCredentials()
  const workspaceId = (parsed.workspace as string | undefined) || creds.workspaceId
  if (!workspaceId) {
    output.error(
      "No workspace specified. Use --workspace <id> or set default workspace with: lyrashield use <id>"
    )
    return 2
  }

  // --attachment is repeatable and references attachment ids that were
  // already uploaded to the workspace; the CLI never uploads local files.
  const attachmentArgs = parsed.attachment as string | string[] | undefined
  const attachmentIds = [
    ...new Set(
      (Array.isArray(attachmentArgs) ? attachmentArgs : [attachmentArgs])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
    ),
  ]
  if (attachmentIds.some((id) => !id)) {
    output.error("--attachment requires a non-empty id of an already-uploaded attachment.")
    return 2
  }

  let targetId = (parsed.target as string | undefined) ?? (parsed._ as string[])[0]
  if (!targetId) {
    const defaultProject = await loadDefaultProject()
    if (defaultProject?.targetId && defaultProject.workspaceId === workspaceId) {
      targetId = defaultProject.targetId
    }
  }
  if (!targetId) {
    output.error("No target specified.")
    output.notice(USAGE)
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

  const workflow = parsed.workflow
    ? ((parsed.workflow as string).toUpperCase() as (typeof VALID_WORKFLOWS)[number])
    : undefined
  if (workflow && !VALID_WORKFLOWS.includes(workflow)) {
    output.error(`Invalid workflow. Choose: ${VALID_WORKFLOWS.join(", ")}`)
    return 2
  }

  const baseRef = parsed.base as string | undefined
  const headRef = parsed.head as string | undefined
  const authorizationRef = parsed["authorization-ref"] as string | undefined
  if (headRef && !baseRef) {
    output.error("--head requires --base so the change set can be compared.")
    return 2
  }
  if ((baseRef || headRef) && workflow !== "REVIEW_CHANGES") {
    output.error("--base/--head are only valid with --workflow REVIEW_CHANGES.")
    return 2
  }
  if (workflow === "REVIEW_CHANGES" && !baseRef) {
    output.error("--workflow REVIEW_CHANGES requires --base <ref> to compare against.")
    return 2
  }
  if (authorizationRef && workflow !== "AUTHENTICATED_ASSESSMENT") {
    output.error("--authorization-ref is only valid with --workflow AUTHENTICATED_ASSESSMENT.")
    return 2
  }
  if (workflow === "AUTHENTICATED_ASSESSMENT" && !authorizationRef) {
    output.error(
      "--workflow AUTHENTICATED_ASSESSMENT requires --authorization-ref <recorded authorization>."
    )
    return 2
  }

  const client = await createClient()
  let res
  try {
    res = await getScanEligibility(client, {
      workspaceId,
      targetId,
      goal,
      mode,
      ...(workflow ? { workflow } : {}),
      ...(baseRef ? { baseRef } : {}),
      ...(headRef ? { headRef } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(authorizationRef ? { authorizationRef } : {}),
    })
  } catch (err) {
    const failure = describeCliFailure(err)
    output.error(failure.message, failure.exitCode)
    return failure.exitCode
  }

  // A denial is a successful read — in --json the full response is the
  // document, not an error.
  if (output.json) {
    output.result(res)
    return res.allowed ? 0 : 1
  }

  if (res.allowed) {
    output.log(`Preflight: allowed — ${goal}/${mode} on target ${targetId}`)
    output.log(
      `Plan: ${res.plan} · ${res.remainingMinutes} agent-minutes remaining${res.isTrial ? " (trial)" : ""}`
    )
    if (res.canonicalMode && res.canonicalMode !== mode) {
      output.log(
        `Review: resolves to canonical mode ${res.canonicalMode}${res.canonicalProfileId ? ` (${res.canonicalProfileId})` : ""}`
      )
    }
    for (const limitation of res.limitations ?? []) {
      output.log(`Note: ${limitation}`)
    }
    output.log("Advisory only — the scan is rechecked authoritatively when it is submitted.")
    return 0
  }

  output.log(`Preflight: denied — ${res.code ?? "SCAN_NOT_ALLOWED"}`)
  if (res.message) output.log(res.message)
  output.log(
    `Plan: ${res.plan} · ${res.remainingMinutes} agent-minutes remaining${res.isTrial ? " (trial)" : ""}`
  )
  const blockers = res.blockers ?? []
  if (blockers.length > 0) {
    output.log("Blockers:")
    for (const blocker of blockers) {
      output.log(`  - ${blocker.code}: ${blocker.message}`)
    }
  }
  for (const limitation of res.limitations ?? []) {
    output.log(`Note: ${limitation}`)
  }
  return 1
}
