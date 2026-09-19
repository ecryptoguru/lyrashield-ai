/* eslint-disable security/detect-non-literal-fs-filename */
import { cp, lstat, mkdir, realpath, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"
import { deriveMcpUrl, type AgentEntry, type ConfigLocation, type Transport } from "@lyrashield/agent-registry"
import { getPluginDir } from "@lyrashield/agent-plugin"
import type { InstallAgentResult } from "./install.js"

export interface InstallAgentPluginOptions {
  agent: AgentEntry
  transport?: Transport
  apiUrl?: string
  scope?: "project" | "global"
  cwd?: string
  dryRun?: boolean
  yes?: boolean
}

const CODEX_PLUGIN_ID = "lyrashield@lyrashield-ai"
const CODEX_MARKETPLACE = "ecryptoguru/lyrashield-marketplace"

function runCodexPluginCommand(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("codex", args, { env: process.env, windowsHide: true }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function installCodexPlugin(dryRun?: boolean): Promise<InstallAgentResult> {
  const commands = [
    `codex plugin marketplace add ${CODEX_MARKETPLACE}`,
    `codex plugin add ${CODEX_PLUGIN_ID}`,
  ]
  if (dryRun) {
    return {
      agent: "openai-codex-agent-plugin",
      displayName: "OpenAI Codex (Agent Plugin)",
      outcome: "DELEGATED",
      message: commands.map((command) => `Would run ${command}`).join("\n"),
    }
  }

  try {
    await runCodexPluginCommand(["plugin", "marketplace", "add", CODEX_MARKETPLACE])
    await runCodexPluginCommand(["plugin", "add", CODEX_PLUGIN_ID])
    return {
      agent: "openai-codex-agent-plugin",
      displayName: "OpenAI Codex (Agent Plugin)",
      outcome: "DELEGATED",
      message: `Installed ${CODEX_PLUGIN_ID}. Restart the ChatGPT desktop app to load it.`,
    }
  } catch (error) {
    return {
      agent: "openai-codex-agent-plugin",
      displayName: "OpenAI Codex (Agent Plugin)",
      outcome: "FAILED",
      message: `Codex plugin install failed: ${(error as Error).message}`,
    }
  }
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

/**
 * Independent containment for registry-driven plugin destinations. Registry
 * paths are statically fixed today, but a future attacker-influenced entry
 * would otherwise give `cp -r`/`rm -r` an arbitrary root (VERIFY-E-006).
 * The destination must resolve strictly inside the intended scope root —
 * homedir for global locations, the project cwd otherwise — and at least two
 * segments deep, so an entry can never name `~`, `/`, `~/.config`, or the
 * project root itself.
 */
async function assertContainedPluginDest(
  dest: string,
  loc: ConfigLocation,
  opts?: { scope?: string; cwd?: string }
): Promise<string> {
  const root =
    loc.scope === "global" ? path.resolve(homedir()) : path.resolve(opts?.cwd ?? process.cwd())
  const resolved = path.resolve(dest)
  const rel = path.relative(root, resolved)
  if (
    rel === "" ||
    rel.startsWith("..") ||
    path.isAbsolute(rel) ||
    rel.split(path.sep).length < 2
  ) {
    throw new Error(`Refusing plugin path outside its scope root: ${dest}`)
  }
  const realRoot = await realpath(root)
  let ancestor = root
  for (const segment of rel.split(path.sep)) {
    ancestor = path.join(ancestor, segment)
    const entry = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (entry?.isSymbolicLink()) {
      throw new Error(`Refusing plugin path through symlink: ${ancestor}`)
    }
    if (entry) {
      const actual = await realpath(ancestor)
      const realRel = path.relative(realRoot, actual)
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        throw new Error(`Refusing plugin path outside its real scope root: ${dest}`)
      }
    }
  }
  return resolved
}

export async function installAgentPlugin(
  opts: InstallAgentPluginOptions
): Promise<InstallAgentResult> {
  const { agent } = opts
  if (agent.id === "openai-codex-agent-plugin") return installCodexPlugin(opts.dryRun)

  if (agent.id === "kiro-agent-plugin" && opts.transport === "remote-http") {
    return { agent: agent.id, displayName: agent.displayName, outcome: "MANUAL_REQUIRED",
      message: `Kiro remote OAuth alternative: add an mcpServers.lyrashield entry with URL ${deriveMcpUrl(opts.apiUrl ?? "https://app.lyrashieldai.com")} in .kiro/settings/mcp.json or ~/.kiro/settings/mcp.json. Complete Kiro's browser OAuth flow and verify a read call. Keep an existing stdio entry until the remote connection passes acceptance.` }
  }

  if (agent.manualInstructions) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "MANUAL_REQUIRED",
      message: agent.manualInstructions,
    }
  }

  const pluginLocations = agent.pluginLocations ?? []

  if (pluginLocations.length === 0) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      message: "No plugin location defined for this agent.",
    }
  }

  const loc =
    pluginLocations.find((l) => !opts.scope || l.scope === opts.scope)
  if (!loc) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      message: "No plugin location matched the current scope.",
    }
  }
  const rawDest = resolvePluginLocation(loc, { scope: opts.scope, cwd: opts.cwd })
  let dest: string
  try {
    dest = await assertContainedPluginDest(rawDest, loc, opts)
  } catch (error) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      path: rawDest,
      message: (error as Error).message,
    }
  }
  const source = getPluginDir()

  const parentDir = path.dirname(dest)
  if (opts.dryRun) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "CONFIGURED",
      path: dest,
      message: `Would copy ${source} -> ${dest}`,
    }
  }

  try {
    await mkdir(parentDir, { recursive: true })
    await assertContainedPluginDest(dest, loc, opts)
  } catch (error) {
    return { agent: agent.id, displayName: agent.displayName, outcome: "FAILED", path: dest,
      message: `Plugin destination is unsafe or unavailable: ${(error as Error).message}` }
  }

  // Confirmation gate: the `yes` option is threaded through from the CLI
  // --yes flag. Without it, a plugin install would silently overwrite an
  // existing install (including user customizations). Require explicit consent
  // only when the destination already exists; fresh installs proceed directly.
  let destExists = false
  try {
    destExists = Boolean(await lstat(dest))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { agent: agent.id, displayName: agent.displayName, outcome: "FAILED", path: dest,
        message: `Cannot inspect existing plugin: ${(error as Error).message}` }
    }
  }
  if (destExists && !opts.yes) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "MANUAL_REQUIRED",
      path: dest,
      message:
        "Confirmation required to overwrite an existing plugin install. Re-run with --yes to proceed.",
    }
  }

  // Stage the new plugin before moving the existing installation.
  const stagePath = `${dest}.lyrashield-stage-${randomUUID()}`
  try {
    await cp(source, stagePath, { recursive: true, preserveTimestamps: true, errorOnExist: true })
  } catch (error) {
    await rm(stagePath, { recursive: true, force: true }).catch(() => {})
    return { agent: agent.id, displayName: agent.displayName, outcome: "FAILED", path: dest,
      message: `Plugin copy failed; existing installation preserved: ${(error as Error).message}` }
  }

  let backupPath: string | undefined
  try {
    if (destExists) {
      backupPath = `${dest}.lyrashield-backup-${randomUUID()}`
      await rename(dest, backupPath)
    }
  } catch (error) {
    await rm(stagePath, { recursive: true, force: true }).catch(() => {})
    return { agent: agent.id, displayName: agent.displayName, outcome: "FAILED", path: dest,
      message: `Plugin backup failed; existing installation preserved: ${(error as Error).message}` }
  }

  try {
    await rename(stagePath, dest)
  } catch (error) {
    await rm(stagePath, { recursive: true, force: true }).catch(() => {})
    let restorationError: string | undefined
    if (backupPath) {
      try {
        await rename(backupPath, dest)
      } catch (restoreError) {
        restorationError = (restoreError as Error).message
      }
    }
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      path: dest,
      backupPath: restorationError ? backupPath : undefined,
      message: `Plugin activation failed: ${(error as Error).message}${restorationError ? `; restore failed: ${restorationError}; previous files retained at ${backupPath}` : ""}`,
    }
  }

  // Keep the previous installation so local customizations remain recoverable.
  if (backupPath) {
    return { agent: agent.id, displayName: agent.displayName, outcome: "CONFIGURED", path: dest,
      backupPath, message: `Plugin installed to ${dest}; previous installation retained at ${backupPath}` }
  }

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
  if (agent.id === "openai-codex-agent-plugin") {
    if (opts.dryRun) {
      return {
        agent: agent.id,
        displayName: agent.displayName,
        outcome: "DELEGATED",
        message: `Would run codex plugin remove ${CODEX_PLUGIN_ID}`,
      }
    }
    try {
      await runCodexPluginCommand(["plugin", "remove", CODEX_PLUGIN_ID])
      return {
        agent: agent.id,
        displayName: agent.displayName,
        outcome: "DELEGATED",
        message: `Removed ${CODEX_PLUGIN_ID}.`,
      }
    } catch (error) {
      return {
        agent: agent.id,
        displayName: agent.displayName,
        outcome: "FAILED",
        message: `Codex plugin removal failed: ${(error as Error).message}`,
      }
    }
  }

  if (agent.manualInstructions) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "MANUAL_REQUIRED",
      message: `LyraShield did not install this integration directly. Remove it through ${agent.displayName}'s marketplace or MCP settings.`,
    }
  }
  const pluginLocations = agent.pluginLocations ?? []
  const loc =
    pluginLocations.find((l) => !opts.scope || l.scope === opts.scope)

  if (!loc) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      message: "No plugin location defined for this agent.",
    }
  }

  const rawDest = resolvePluginLocation(loc, { scope: opts.scope, cwd: opts.cwd })
  let dest: string
  try {
    // rm -r on a registry-resolved path: containment is verified
    // independently of the registry content itself.
    dest = await assertContainedPluginDest(rawDest, loc, opts)
  } catch (error) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      path: rawDest,
      message: (error as Error).message,
    }
  }

  let existing: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    existing = await lstat(dest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { agent: agent.id, displayName: agent.displayName, outcome: "FAILED", path: dest,
        message: `Cannot inspect plugin: ${(error as Error).message}` }
    }
  }
  if (!existing) return {
    agent: agent.id, displayName: agent.displayName, outcome: "ALREADY_CONFIGURED",
    message: "Plugin was not present.",
  }
  if (opts.dryRun) return {
    agent: agent.id, displayName: agent.displayName, outcome: "CONFIGURED", path: dest,
    message: `Would remove ${dest}`,
  }
  try {
    await rm(dest, { recursive: true, force: true })
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "CONFIGURED",
      path: dest,
      message: "Plugin removed.",
    }
  } catch (error) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      path: dest,
      message: `Plugin removal failed: ${(error as Error).message}`,
    }
  }
}
