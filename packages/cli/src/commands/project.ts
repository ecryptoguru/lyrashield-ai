/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync } from "node:fs"
import minimist from "minimist"
import { parseRepoIdentifier, type ParsedRepo } from "@lyrashield/sdk"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"
import {
  clearDefaultProject,
  findOrCreateRepoTarget,
  loadDefaultProject,
  resolveRepoFromPath,
  saveDefaultProject,
} from "../projects.js"

function usage(): string {
  return `lyrashield project <subcommand>

Subcommands:
  use [path]              Detect current git repo or use a path, then set it as the default project
    --repo <owner/repo>   Use a specific repository (e.g. ecryptoguru/lyrashield-ai)
    --name <name>         Set a display name for a newly created target
  list                    List workspace targets and mark the default project
  switch <targetId>       Set an existing target as the default project
  current                 Show the current default project
  clear                   Clear the current default project`
}

async function handleProjectUse(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, { string: ["repo", "name"] })
  const [positional] = parsed._ as string[]

  let repo: ParsedRepo | undefined
  let name: string | undefined = parsed.name as string | undefined

  if (parsed.repo) {
    repo = parseRepoIdentifier(parsed.repo as string)
    if (!repo) {
      output.error("Invalid --repo format. Use owner/repo or a full git URL.")
      return 2
    }
  } else if (positional) {
    if (existsSync(positional)) {
      const resolved = await resolveRepoFromPath(positional)
      if (!resolved.repo) {
        output.error(`No git origin remote found at ${positional}`)
        return 2
      }
      repo = resolved.repo
    } else {
      repo = parseRepoIdentifier(positional)
      if (!repo) {
        output.error(`Invalid repository or path: ${positional}`)
        return 2
      }
    }
  } else {
    const resolved = await resolveRepoFromPath()
    if (!resolved.repo) {
      output.error("No git origin remote found in the current directory.")
      output.notice("Provide a path, a repo (owner/repo), or use --repo.")
      return 2
    }
    repo = resolved.repo
  }

  if (!repo) {
    output.error("Could not determine a repository.")
    return 2
  }

  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

  const target = await findOrCreateRepoTarget(client, workspaceId, repo, name)
  await saveDefaultProject({
    workspaceId,
    targetId: target.id,
    name: target.name,
    repository: repo.repoFullName,
  })

  output.log(`Default project set to ${repo.repoFullName} (${target.id})`)
  return 0
}

async function handleProjectList(args: string[], output: Output): Promise<number> {
  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()
  const current = await loadDefaultProject()

  const { items: targets } = (await client.request(
    "GET",
    `/targets?workspaceId=${encodeURIComponent(workspaceId)}`
  )) as {
    items: Array<{
      id: string
      name: string
      repoFullName?: string | null
      url?: string | null
      type: string
    }>
  }

  if (!targets.length) {
    output.notice("No targets in this workspace. Run: lyrashield project use")
    return 0
  }

  const rows = targets.map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    repo: t.repoFullName ?? t.url ?? "-",
    default: t.id === current?.targetId ? "*" : "",
  }))

  output.result(rows)
  return 0
}

async function handleProjectSwitch(args: string[], output: Output): Promise<number> {
  const [targetId] = args
  if (!targetId) {
    output.error("usage: lyrashield project switch <targetId>")
    return 2
  }

  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

  const { items: targets } = (await client.request(
    "GET",
    `/targets?workspaceId=${encodeURIComponent(workspaceId)}`
  )) as {
    items: Array<{ id: string; name: string; repoFullName?: string | null; url?: string | null }>
  }

  const target = targets.find((t) => t.id === targetId)
  if (!target) {
    output.error(`Target ${targetId} not found in workspace ${workspaceId}`)
    return 2
  }

  await saveDefaultProject({
    workspaceId,
    targetId: target.id,
    name: target.name,
    repository: target.repoFullName ?? undefined,
    url: target.url ?? undefined,
  })

  output.log(`Default project switched to ${target.name} (${target.id})`)
  return 0
}

async function handleProjectCurrent(args: string[], output: Output): Promise<number> {
  const current = await loadDefaultProject()
  if (!current) {
    output.notice("No default project. Run: lyrashield project use")
    return 0
  }
  output.result(current)
  return 0
}

async function handleProjectClear(args: string[], output: Output): Promise<number> {
  await clearDefaultProject()
  output.log("Default project cleared.")
  return 0
}

export async function handleProject(args: string[], output: Output): Promise<number> {
  const [subcommand, ...rest] = args
  if (!subcommand) {
    output.notice(usage())
    return 0
  }

  switch (subcommand) {
    case "use":
      return handleProjectUse(rest, output)
    case "list":
      return handleProjectList(rest, output)
    case "switch":
      return handleProjectSwitch(rest, output)
    case "current":
      return handleProjectCurrent(rest, output)
    case "clear":
      return handleProjectClear(rest, output)
    case "--help":
    case "-h":
      output.notice(usage())
      return 0
    default:
      output.error(`Unknown project subcommand: ${subcommand}`)
      output.notice(usage())
      return 2
  }
}
