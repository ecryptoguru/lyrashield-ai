import { env } from "@lyrashield/config"

export type TargetType = "REPO" | "WEB_APP" | "API" | "CLOUD_ACCOUNT" | "CONTAINER" | "IAC"

export interface TargetInfo {
  id: string
  type: TargetType
  url?: string | null
  repoFullName?: string | null
  repoUrl?: string | null
  name: string
}

export interface ScanConfig {
  scanId: string
  goal: string
  mode: string
  target: TargetInfo
  instruction?: string
  maxBudgetUsd?: number
}

export interface EngineCommand {
  executable: string
  args: string[]
  workDir: string
}

const SCAN_MODE_MAP: Record<string, "quick" | "standard" | "deep"> = {
  SAFE: "quick",
  QUICK: "quick",
  STANDARD: "standard",
  DEEP: "deep",
  CUSTOM: "deep",
}

function resolveTargetArg(target: TargetInfo): string {
  switch (target.type) {
    case "REPO":
      if (target.repoUrl) return target.repoUrl
      if (target.repoFullName) return `https://github.com/${target.repoFullName}`
      throw new Error("REPO target missing repoUrl and repoFullName")
    case "WEB_APP":
    case "API":
      if (!target.url) throw new Error(`${target.type} target missing url`)
      return target.url
    case "CLOUD_ACCOUNT":
    case "CONTAINER":
    case "IAC":
      if (!target.url) throw new Error(`${target.type} target missing url`)
      return target.url
    default:
      throw new Error(`Unsupported target type: ${target.type}`)
  }
}

function resolveExecutable(): string {
  const enginePath = env.LYRASHIELD_ENGINE_PATH
  if (enginePath) return enginePath
  return "lyrashield"
}

export function buildEngineCommand(config: ScanConfig): EngineCommand {
  const executable = resolveExecutable()
  const targetArg = resolveTargetArg(config.target)
  const scanMode = SCAN_MODE_MAP[config.mode] ?? "deep"

  const args: string[] = ["--non-interactive", "--target", targetArg, "--scan-mode", scanMode]

  if (config.instruction) {
    args.push("--instruction", config.instruction)
  }

  if (config.maxBudgetUsd && config.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(config.maxBudgetUsd))
  }

  const workDir = `lyrashield_runs/${config.scanId}`

  return { executable, args, workDir }
}
