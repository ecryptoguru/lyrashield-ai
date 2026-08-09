import { execFile } from "node:child_process"
import { basename } from "node:path"
import process from "node:process"
import path from "node:path"
import type {
  AgentEntry,
  ConfigLocation,
  InstallOptions,
  InstallOutcome,
  RenderedEntry,
  Transport,
} from "@lyrashield/agent-registry"
import { detectAgent, resolveLocation, findDetectedLocations } from "./detect.js"
import { resolveSecretMode, secretWarning } from "./secret-mode.js"
import { mergeFile } from "./merge.js"

export interface InstallAgentOptions {
  agent: AgentEntry
  transport: Transport
  apiUrl: string
  apiKey?: string
  serverName?: string
  scope?: "project" | "global"
  all?: boolean
  dryRun?: boolean
  inlineSecret?: boolean
  yes?: boolean
  cwd?: string
}

// Vendor CLIs must be explicitly allowlisted. A compromised registry entry or
// local config must not be able to invoke arbitrary binaries.
const VENDOR_COMMAND_ALLOWLIST = new Set(["claude", "amp"])

export interface InstallAgentResult {
  agent: string
  displayName: string
  outcome: InstallOutcome
  path?: string
  backupPath?: string
  message?: string
}

function renderManualInstructions(agent: AgentEntry, opts: InstallAgentOptions): string {
  const serverName = opts.serverName ?? "lyrashield"
  const command = "npx"
  const args = ["-y", "@lyrashield/mcp"]
  const env = {
    LYRASHIELD_API_KEY: "$LYRASHIELD_API_KEY",
    LYRASHIELD_API_URL: opts.apiUrl,
  }
  return `[${agent.displayName} — manual configuration]
Server name: ${serverName}
Command:     ${command}
Args:        ${JSON.stringify(args)}
Env:         ${JSON.stringify(env, null, 2)}`
}

async function tryMergeLocation(
  agent: AgentEntry,
  loc: ConfigLocation,
  opts: InstallAgentOptions
): Promise<InstallAgentResult | undefined> {
  const resolved = resolveLocation(loc, { scope: opts.scope, cwd: opts.cwd ?? process.cwd() })
  const secret = await resolveSecretMode({
    agent,
    location: loc,
    transport: opts.transport,
    apiKey: opts.apiKey,
    apiUrl: opts.apiUrl,
    inlineSecret: opts.inlineSecret,
    dryRun: opts.dryRun,
    cwd: opts.cwd ?? process.cwd(),
  })

  if (secret.mode === "manual") {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "MANUAL_REQUIRED",
      path: resolved,
      message: secret.reason,
    }
  }

  const installOpts: InstallOptions = {
    transport: opts.transport,
    apiUrl: opts.apiUrl,
    secretMode: (secret.mode === "interpolated"
      ? "interpolated"
      : secret.mode === "shell"
        ? "shell"
        : secret.mode === "header"
          ? "header"
          : "inline") as InstallOptions["secretMode"],
    apiKey: opts.apiKey,
    serverName: opts.serverName,
  }

  const { renderEntry } = await import("@lyrashield/agent-registry").then(
    (m) => m as { renderEntry: (agent: AgentEntry, opts: InstallOptions) => RenderedEntry }
  )
  const rendered = renderEntry(agent, installOpts)

  const result = await mergeFile({
    filePath: resolved,
    format: agent.format!,
    rootKey: rendered.rootKey,
    serverName: rendered.entryKey,
    value: rendered.value,
    dryRun: opts.dryRun,
    chmod0600: secret.mode === "inline",
  })

  const warning = secretWarning(secret, resolved, opts.dryRun)

  return {
    agent: agent.id,
    displayName: agent.displayName,
    outcome: result.changed ? "CONFIGURED" : "ALREADY_CONFIGURED",
    path: resolved,
    backupPath: result.backupPath,
    message: warning,
  }
}

async function runVendorCli(
  agent: AgentEntry,
  opts: InstallAgentOptions
): Promise<InstallAgentResult> {
  if (!agent.vendorCli) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      message: `No vendor CLI defined for ${agent.id}`,
    }
  }

  const rawCommand = agent.vendorCli.command
  const command = basename(rawCommand).trim()
  if (!command || !VENDOR_COMMAND_ALLOWLIST.has(command)) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "FAILED",
      message: `Vendor CLI command is not allowlisted: ${rawCommand}`,
    }
  }

  const args = [...agent.vendorCli.args]
  const env = {
    ...process.env,
    LYRASHIELD_API_KEY: opts.apiKey ?? "",
    LYRASHIELD_API_URL: opts.apiUrl,
  }

  return new Promise((resolve) => {
    execFile(command, args, { env }, (err) => {
      if (err) {
        resolve({
          agent: agent.id,
          displayName: agent.displayName,
          outcome: "FAILED",
          message: `Vendor CLI failed: ${err.message}`,
        })
      } else {
        resolve({
          agent: agent.id,
          displayName: agent.displayName,
          outcome: "DELEGATED",
          message: `${command} ${args.join(" ")}`,
        })
      }
    })
  })
}

export async function installAgent(opts: InstallAgentOptions): Promise<InstallAgentResult> {
  const { agent, all, cwd } = opts

  if (agent.installStrategy === "agent-plugin") {
    const { installAgentPlugin } = await import("./agent-plugin.js")
    return installAgentPlugin({
      agent,
      scope: opts.scope,
      cwd: opts.cwd,
      dryRun: opts.dryRun,
      yes: opts.yes,
    })
  }

  if (agent.installStrategy === "guided-manual") {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "MANUAL_REQUIRED",
      message: renderManualInstructions(agent, opts) + "\n\n" + agent.gotchas.join("\n"),
    }
  }

  if (agent.installStrategy === "vendor-cli") {
    return runVendorCli(agent, opts)
  }

  const baseDir = cwd ?? process.cwd()

  const detected = await detectAgent(agent, { scope: opts.scope, cwd: baseDir })
  if (!detected && !all) {
    return { agent: agent.id, displayName: agent.displayName, outcome: "NOT_DETECTED" }
  }

  const locationStates = await findDetectedLocations(agent, {
    scope: opts.scope,
    cwd: baseDir,
  })
  for (const state of locationStates) {
    if (opts.scope && state.location.scope !== opts.scope) continue
    if (!all && !state.exists) {
      const parent = path.dirname(state.resolvedPath)
      const parentExists = await import("node:fs/promises")
        .then(({ stat }) =>
          stat(parent)
            .then((s) => s.isDirectory())
            .catch(() => false)
        )
        .catch(() => false)
      if (!parentExists) continue
    }
    const result = await tryMergeLocation(agent, state.location, opts)
    if (result) return result
  }

  return {
    agent: agent.id,
    displayName: agent.displayName,
    outcome: "FAILED",
    message: "No writable location matched the current scope.",
  }
}

export async function uninstallAgent(
  agent: AgentEntry,
  opts: { scope?: "project" | "global"; serverName?: string; cwd?: string }
): Promise<InstallAgentResult> {
  const serverName = opts.serverName ?? "lyrashield"

  if (agent.installStrategy === "agent-plugin") {
    const { uninstallAgentPlugin } = await import("./agent-plugin.js")
    return uninstallAgentPlugin({ agent, scope: opts.scope, cwd: opts.cwd })
  }

  const { removeFile } = await import("./merge.js")

  if (agent.installStrategy !== "config-file" || !agent.format || !agent.rootKey) {
    return {
      agent: agent.id,
      displayName: agent.displayName,
      outcome: "MANUAL_REQUIRED",
      message: "Uninstall is not supported for this agent strategy.",
    }
  }

  for (const loc of agent.locations) {
    if (opts.scope && loc.scope !== opts.scope) continue
    const resolved = resolveLocation(loc, { scope: opts.scope, cwd: opts.cwd ?? process.cwd() })
    const removed = await removeFile({
      filePath: resolved,
      format: agent.format,
      rootKey: agent.rootKey,
      serverName,
    })
    if (removed) {
      return {
        agent: agent.id,
        displayName: agent.displayName,
        outcome: "CONFIGURED",
        path: resolved,
        message: "LyraShield entry removed.",
      }
    }
  }

  return {
    agent: agent.id,
    displayName: agent.displayName,
    outcome: "ALREADY_CONFIGURED",
    message: "LyraShield entry was not present.",
  }
}
