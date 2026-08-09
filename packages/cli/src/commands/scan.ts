import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"
import { parseRepoIdentifier, type ParsedRepo } from "@lyrashield/sdk"
import {
  findOrCreateRepoTarget,
  loadDefaultProject,
  resolveRepoFromPath,
  saveDefaultProject,
} from "../projects.js"

const VALID_GOALS = [
  "CHECK_PR",
  "TEST_APP",
  "LAUNCH_REVIEW",
  "WEEKLY_MONITOR",
  "FULL_PENTEST",
  "COMPLIANCE_REVIEW",
]
const VALID_MODES = ["SAFE", "QUICK", "STANDARD", "DEEP", "CUSTOM"]

async function resolveTarget(
  args: {
    targetId?: string
    auto?: boolean
    repo?: string
    name?: string
    workspaceId: string
  },
  output: Output
): Promise<{ targetId: string; repository?: string; isNew: boolean } | null> {
  // 1. Explicit target wins.
  if (args.targetId) return { targetId: args.targetId, isNew: false }

  // 2. Explicit repository selection wins over an implicit saved default.
  if (args.auto || args.repo) {
    const client = await createClient()

    let repo: ParsedRepo | undefined
    if (args.repo) {
      repo = parseRepoIdentifier(args.repo)
      if (!repo) {
        output.error(`Invalid repo format: ${args.repo}`)
        return null
      }
    } else {
      const resolved = await resolveRepoFromPath()
      if (!resolved.repo) {
        output.error("No git origin remote found. Run from a git repo, or pass --repo.")
        return null
      }
      repo = resolved.repo
    }

    const target = await findOrCreateRepoTarget(client, args.workspaceId, repo, args.name)
    await saveDefaultProject({
      workspaceId: args.workspaceId,
      targetId: target.id,
      name: target.name,
      repository: repo.repoFullName,
    })
    return { targetId: target.id, repository: repo.repoFullName, isNew: true }
  }

  // 3. Use the saved default project only if it belongs to this workspace.
  const defaultProject = await loadDefaultProject()
  if (defaultProject?.targetId && defaultProject.workspaceId === args.workspaceId) {
    return { targetId: defaultProject.targetId, isNew: false }
  }

  return null
}

export async function handleScan(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: ["target", "goal", "mode", "repo", "name"],
    boolean: ["watch", "auto"],
    default: { goal: "TEST_APP", mode: "STANDARD" },
    alias: { t: "target", g: "goal", m: "mode" },
  })

  const client = await createClient()
  const workspaceId = requireWorkspace(await getEffectiveCredentials())

  const [targetId] = parsed._ as string[]
  const resolved = await resolveTarget(
    {
      targetId: (parsed.target as string) ?? targetId,
      auto: parsed.auto as boolean,
      repo: parsed.repo as string | undefined,
      name: parsed.name as string | undefined,
      workspaceId,
    },
    output
  )

  if (!resolved) {
    output.error("No target specified.")
    output.notice("usage: lyrashield scan --target <targetId> [--goal ...] [--mode ...]")
    output.notice("       lyrashield scan --auto [--repo owner/repo] [--name ...]")
    output.notice("       lyrashield project use  # set a default project once")
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

  // Fail before submitting. Warning after a successful POST and still exiting 0
  // would tell a CI script the scan was followed to completion when it was not,
  // and re-running would submit a second scan against the workspace budget.
  if (parsed.watch) {
    output.error(
      "--watch is not implemented yet. Submit the scan without --watch, then poll it with: lyrashield status <scanId>"
    )
    return 2
  }

  const res = (await client.request("POST", "/scans", {
    body: { workspaceId, targetId: resolved.targetId, goal, mode },
  })) as { id: string }

  if (resolved.isNew && resolved.repository) {
    output.log(`Resolved project ${resolved.repository} → target ${resolved.targetId}`)
  }
  output.result(res)

  return 0
}
