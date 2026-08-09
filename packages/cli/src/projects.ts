/* eslint-disable security/detect-non-literal-fs-filename */
import { readFile, writeFile, access, mkdir, rename, unlink, chmod } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { parseRepoIdentifier, type LyraShieldClient, type ParsedRepo } from "@lyrashield/sdk"

const PROJECTS_DIR = path.join(homedir(), ".lyrashield")
const PROJECTS_FILE = path.join(PROJECTS_DIR, "project.json")

export interface StoredProject {
  workspaceId: string
  targetId: string
  name: string
  repository?: string
  url?: string
}

const execFileAsync = promisify(execFile)

export interface ResolveRepoResult {
  repo: ParsedRepo | undefined
  cwd: string
}

export async function getProjectsDir(): Promise<string> {
  await mkdir(PROJECTS_DIR, { recursive: true, mode: 0o700 })
  return PROJECTS_DIR
}

export function getProjectFilePath(): string {
  return PROJECTS_FILE
}

export async function loadDefaultProject(): Promise<StoredProject | undefined> {
  try {
    await access(PROJECTS_FILE)
  } catch {
    return undefined
  }
  try {
    const raw = await readFile(PROJECTS_FILE, "utf-8")
    const parsed = JSON.parse(raw) as unknown
    if (isStoredProject(parsed)) return parsed
  } catch {
    // ignore malformed file
  }
  return undefined
}

export async function saveDefaultProject(project: StoredProject): Promise<void> {
  await getProjectsDir()
  const tmp = `${PROJECTS_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(project, null, 2), { mode: 0o600 })
  await setFileMode(tmp, 0o600)
  await rename(tmp, PROJECTS_FILE)
}

export async function clearDefaultProject(): Promise<void> {
  try {
    await unlink(PROJECTS_FILE)
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return
    throw err
  }
}

async function setFileMode(file: string, mode: number): Promise<void> {
  try {
    await chmod(file, mode)
  } catch {
    // ignore platforms without chmod semantics
  }
}

function isStoredProject(value: unknown): value is StoredProject {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.workspaceId === "string" &&
    typeof obj.targetId === "string" &&
    typeof obj.name === "string"
  )
}

export async function resolveRepoFromPath(cwd?: string): Promise<ResolveRepoResult> {
  const dir = cwd ? path.resolve(cwd) : process.cwd()
  try {
    const { stdout } = await execFileAsync("git", ["remote", "-v"], { cwd: dir })
    const lines = stdout.split("\n")
    for (const line of lines) {
      const match = line.match(/^origin\s+(\S+)\s+\(fetch\)/)
      if (match) {
        const remote = match[1]
        if (remote) {
          const repo = parseRepoIdentifier(remote)
          if (repo) return { repo, cwd: dir }
        }
      }
    }
  } catch {
    // not a git repo or git not available
  }
  return { repo: undefined, cwd: dir }
}

export async function findTargetByRepository(
  client: LyraShieldClient,
  workspaceId: string,
  repo: ParsedRepo
): Promise<{ id: string; name: string; repoFullName?: string | null } | undefined> {
  let cursor: string | undefined
  do {
    const params = new URLSearchParams({ workspaceId })
    if (cursor) params.set("cursor", cursor)
    const response = (await client.request("GET", `/targets?${params.toString()}`)) as {
      items?: Array<{
        id: string
        name: string
        repoFullName?: string | null
        url?: string | null
      }>
      nextCursor?: string | null
    }
    const existing = response.items?.find((t) => t.repoFullName === repo.repoFullName)
    if (existing) return existing
    cursor = response.nextCursor ?? undefined
  } while (cursor)
  return undefined
}

export async function createRepoTarget(
  client: LyraShieldClient,
  workspaceId: string,
  repo: ParsedRepo,
  name?: string
): Promise<{ id: string; name: string }> {
  const result = (await client.request("POST", "/targets", {
    body: {
      workspaceId,
      name: name ?? repo.repoName,
      type: "REPO",
      repoProvider: repo.repoProvider,
      repoOwner: repo.repoOwner,
      repoName: repo.repoName,
      repoFullName: repo.repoFullName,
    },
  })) as { id: string; name: string }
  return result
}

export async function findOrCreateRepoTarget(
  client: LyraShieldClient,
  workspaceId: string,
  repo: ParsedRepo,
  name?: string
): Promise<{ id: string; name: string }> {
  const existing = await findTargetByRepository(client, workspaceId, repo)
  if (existing) return { id: existing.id, name: existing.name }
  return createRepoTarget(client, workspaceId, repo, name)
}
