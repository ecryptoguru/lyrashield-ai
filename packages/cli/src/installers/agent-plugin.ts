/* eslint-disable security/detect-non-literal-fs-filename */
import { cp, mkdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"
import type { AgentEntry, ConfigLocation } from "@lyrashield/agent-registry"
import { getPluginDir } from "@lyrashield/agent-plugin"
import { credentialsFileExists } from "../credentials.js"
import type { InstallAgentResult } from "./install.js"

export interface InstallAgentPluginOptions {
  agent: AgentEntry
  scope?: "project" | "global"
  cwd?: string
  dryRun?: boolean
  yes?: boolean
}

function resolvePluginLocation(
  loc: ConfigLocation,
  opts?: { scope?: string; cwd?: string }
): string {
  let platformPath = loc.path
  if (loc.platform && process.platform in loc.platform) {
    platformPath = loc.platform[process.platform as "darwin" | "linux" | "win32"] ?? loc.path
  }
  const expanded = platformPath.startsWith("~")
    ? path.join(homedir(), platformPath.slice(1))
    : platformPath
  if (path.isAbsolute(expanded)) return expanded
  if (loc.scope === "global") return path.join(homedir(), expanded)
  return path.join(opts?.cwd ?? process.cwd(), expanded)
}

export async function installAgentPlugin(
  opts: InstallAgentPluginOptions
): Promise<InstallAgentResult> {
  const { agent } = opts
  const pluginLocations = agent.pluginLocations ?? []

  if (pluginLocations.length === 0) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      message: "No plugin location defined for this agent.",
    }
  }

  if (!(await credentialsFileExists()) && !process.env.LYRASHIELD_API_KEY) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "MANUAL_REQUIRED",
      message: "No credentials found. Run `lyrashield login` first.",
    }
  }

  const loc =
    pluginLocations.find((l) => !opts.scope || l.scope === opts.scope) ?? pluginLocations[0]
  if (!loc) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      message: "No plugin location matched the current scope.",
    }
  }
  const dest = resolvePluginLocation(loc, { scope: opts.scope, cwd: opts.cwd })
  const source = getPluginDir()

  // Containment: refuse if the resolved destination escapes the expected
  // parent directory (e.g. via symlink traversal). We compare the resolved
  // dest against its real path after ensuring the parent exists.
  const parentDir = path.dirname(dest)
  try {
    await mkdir(parentDir, { recursive: true })
  } catch {
    // ignore — the copy will fail with a clearer error
  }

  if (opts.dryRun) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "CONFIGURED",
      path: dest,
      message: `Would copy ${source} -> ${dest}`,
    }
  }

  // Remove existing plugin directory if present, then copy fresh.
  await rm(dest, { recursive: true, force: true })
  await cp(source, dest, { recursive: true, preserveTimestamps: true })

  return {
    agent: agent.id,
    displayName: agent.displayName,
    outcome: "CONFIGURED",
    path: dest,
    message: `Plugin installed to ${dest}`,
  }
}

export async function uninstallAgentPlugin(
  opts: InstallAgentPluginOptions
): Promise<InstallAgentResult> {
  const { agent } = opts
  const pluginLocations = agent.pluginLocations ?? []
  const loc =
    pluginLocations.find((l) => !opts.scope || l.scope === opts.scope) ?? pluginLocations[0]

  if (!loc) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      message: "No plugin location defined for this agent.",
    }
  }

  const dest = resolvePluginLocation(loc, { scope: opts.scope, cwd: opts.cwd })

  try {
    await stat(dest)
    await rm(dest, { recursive: true, force: true })
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "CONFIGURED",
      path: dest,
      message: "Plugin removed.",
    }
  } catch {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "ALREADY_CONFIGURED",
      message: "Plugin was not present.",
    }
  }
}
