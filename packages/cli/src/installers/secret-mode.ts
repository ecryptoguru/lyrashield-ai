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
  dryRun?: boolean
  cwd?: string
}

async function isFileGitTracked(filePath: string, cwd?: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "--error-unmatch", filePath],
      { cwd: cwd ?? process.cwd() },
      (err) => {
        resolve(!err)
      }
    )
  })
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

  if (agent.id === "gemini-cli") {
    return { mode: "inline", envVar }
  }

  if (agent.credential.kind === "interpolated-env") {
    return { mode: "interpolated", envVar, syntax: agent.credential.syntax }
  }

  if (agent.credential.kind === "shell-env") {
    return { mode: "shell", envVar }
  }

  if (agent.credential.kind === "http-header") {
    return { mode: "header", header: agent.credential.header, envVar }
  }

  if (location.sharedByConvention) {
    if (inlineSecret) {
      const tracked = await isFileGitTracked(location.path, cwd)
      const ignored = await isFileGitIgnored(location.path, cwd)
      if (tracked && !ignored) {
        return {
          mode: "manual",
          reason: `Refusing to inline secret into ${location.path}: file is tracked by git and not ignored. Use a .env or shell export instead.`,
        }
      }
      return { mode: "inline", envVar }
    }

    return {
      mode: "manual",
      reason: `Refusing to inline secret into shared config ${location.path}. Pass --inline-secret only if the file is gitignored.`,
    }
  }

  // Global, non-shared files may contain the secret.
  return { mode: "inline", envVar }
}

export function secretValue(
  mode: ResolvedSecretMode,
  apiKey: string | undefined
): string | undefined {
  if (mode.mode === "manual") return undefined
  if (mode.mode === "shell") return undefined
  if (mode.mode === "header") return undefined
  if (mode.mode === "interpolated") return mode.syntax.replace(/VAR|KEY|NAME/g, mode.envVar)
  if (mode.mode === "inline") return apiKey
  return undefined
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
