import { execFile } from "node:child_process"
import process from "node:process"
import type { AgentEntry, ConfigLocation, Transport } from "@lyrashield/agent-registry"

export type ResolvedSecretMode =
  | { mode: "interpolated"; envVar: string; syntax: string }
  | { mode: "shell"; envVar: string }
  | { mode: "inline"; envVar: string }
  | { mode: "header"; header: string; envVar: string }
  | { mode: "manual"; reason: string }

export interface SecretModeOptions {
  agent: AgentEntry
  location: ConfigLocation
  transport: Transport
  apiKey?: string
  apiUrl: string
  inlineSecret?: boolean
  useCredentialStore?: boolean
  dryRun?: boolean
  cwd?: string
}

async function isFileGitIgnored(filePath: string, cwd?: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["check-ignore", filePath], { cwd: cwd ?? process.cwd() }, (err) => {
      resolve(!err)
    })
  })
}

export async function resolveSecretMode(opts: SecretModeOptions): Promise<ResolvedSecretMode> {
  const { agent, location, inlineSecret, cwd } = opts

  const envVar = "LYRASHIELD_API_KEY"

  if (opts.useCredentialStore) {
    if (opts.transport !== "stdio") {
      return {
        mode: "manual",
        reason:
          "Remote MCP connections authenticate in the client. Complete that client's OAuth flow, or use an API key only when the client cannot use OAuth.",
      }
    }
    return { mode: "shell", envVar }
  }

  let mode: ResolvedSecretMode["mode"]
  if (agent.forceInlineEnv) {
    mode = "inline"
  } else if (agent.credential.kind === "interpolated-env") {
    mode = "interpolated"
  } else if (agent.credential.kind === "shell-env") {
    mode = "shell"
  } else if (agent.credential.kind === "http-header") {
    mode = "header"
  } else {
    mode = "inline"
  }

  const writesRawSecret = mode === "inline" || mode === "header"
  if (location.sharedByConvention && writesRawSecret) {
    if (!inlineSecret) {
      return {
        mode: "manual",
        reason: `Refusing to inline secret into shared config ${location.path}. Pass --inline-secret only if the file is gitignored.`,
      }
    }

    const ignored = await isFileGitIgnored(location.path, cwd)
    if (!ignored) {
      return {
        mode: "manual",
        reason: `Refusing to inline secret into ${location.path}: file is not ignored by git. Use a .env or shell export instead.`,
      }
    }
  }

  if (mode === "interpolated") {
    return { mode: "interpolated", envVar, syntax: (agent.credential as { syntax: string }).syntax }
  }
  if (mode === "header") {
    return { mode: "header", header: (agent.credential as { header: string }).header, envVar }
  }
  return { mode: mode as "inline" | "shell", envVar }
}

export function secretWarning(
  mode: ResolvedSecretMode,
  filePath: string,
  dryRun = false
): string | undefined {
  if (mode.mode === "inline") {
    return dryRun
      ? `Would write secret to ${filePath}.`
      : `Secret written to ${filePath}. Ensure the file is not committed.`
  }
  return undefined
}
