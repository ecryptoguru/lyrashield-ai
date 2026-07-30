import { access, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"
import { execFile } from "node:child_process"
import type { AgentEntry, ConfigLocation } from "@lyrashield/agent-registry"

export interface DetectedLocation {
  location: ConfigLocation
  resolvedPath: string
  exists: boolean
  hasEntry: boolean
  rootKeyCorrect?: boolean
}

export function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(homedir(), p.slice(1))
  if (p === "~\\" || p.startsWith("~\\")) return path.join(homedir(), p.slice(1))
  return p
}

export function resolveLocation(
  loc: ConfigLocation,
  opts?: { scope?: "project" | "global"; cwd?: string }
): string {
  const scope = opts?.scope ?? loc.scope
  let platformPath = loc.path
  if (loc.platform && process.platform in loc.platform) {
    platformPath = loc.platform[process.platform as "darwin" | "linux" | "win32"] ?? loc.path
  }
  const expanded = expandTilde(platformPath)
  if (path.isAbsolute(expanded)) return expanded
  if (scope === "global") return path.join(homedir(), expanded)
  return path.join(opts?.cwd ?? process.cwd(), expanded)
}

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32"
    const cmd = isWin ? "where" : "command"
    const args = isWin ? [command] : ["-v", command]
    execFile(cmd, args, { env: process.env, shell: false, windowsHide: true }, (err) => {
      resolve(!err)
    })
  })
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function detectAgent(
  agent: AgentEntry,
  opts?: { scope?: "project" | "global"; cwd?: string }
): Promise<boolean> {
  if (agent.installStrategy === "vendor-cli") {
    if (agent.vendorCli) return commandExists(agent.vendorCli.command)
    return commandExists(agent.id)
  }
  if (agent.installStrategy === "guided-manual") {
    // No file path to probe; rely on IDE presence if we can guess a binary.
    return false
  }
  for (const loc of agent.locations) {
    const resolved = resolveLocation(loc, opts)
    if (await pathExists(resolved)) return true
    const parent = path.dirname(resolved)
    if (await isDirectory(parent)) return true
  }
  return false
}

export async function detectLocation(
  agent: AgentEntry,
  loc: ConfigLocation,
  opts?: { scope?: "project" | "global"; cwd?: string }
): Promise<DetectedLocation> {
  const resolvedPath = resolveLocation(loc, opts)
  const exists = await pathExists(resolvedPath)
  const out: DetectedLocation = { location: loc, resolvedPath, exists, hasEntry: false }
  if (!exists || !agent.rootKey) return out

  try {
    const raw = await import("node:fs/promises").then(({ readFile }) =>
      readFile(resolvedPath, "utf-8")
    )
    let parsed: unknown
    if (agent.format === "json" || agent.format === "jsonc") {
      const { parse } = await import("jsonc-parser")
      parsed = parse(raw) ?? {}
    } else if (agent.format === "toml") {
      parsed = await import("@iarna/toml").then((m) => m.parse(raw))
    } else if (agent.format === "yaml") {
      parsed = await import("yaml").then((m) => m.default.parse(raw))
    } else {
      return out
    }
    if (parsed && typeof parsed === "object" && agent.rootKey) {
      out.rootKeyCorrect = agent.rootKey in (parsed as Record<string, unknown>)
      const root = (parsed as Record<string, unknown>)[agent.rootKey]
      out.hasEntry = !!(
        root &&
        typeof root === "object" &&
        (root as Record<string, unknown>)["lyrashield"]
      )
    }
  } catch {
    // ignore malformed files
  }
  return out
}

export async function findDetectedLocations(
  agent: AgentEntry,
  opts?: { scope?: "project" | "global"; cwd?: string }
): Promise<DetectedLocation[]> {
  return Promise.all(agent.locations.map((loc) => detectLocation(agent, loc, opts)))
}
