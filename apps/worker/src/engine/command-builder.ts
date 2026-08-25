import { env } from "@lyrashield/config"
import { checkInstructionSafety } from "@lyrashield/security"
import { resolveScanProfile } from "@lyrashield/types"
import { engineWorkspacePath } from "./workspace-path"

export type TargetType = "REPO" | "WEB_APP" | "API" | "CLOUD_ACCOUNT" | "CONTAINER" | "IAC"

export interface TargetInfo {
  id: string
  type: TargetType
  url?: string | null
  repoFullName?: string | null
  repoUrl?: string | null
  branch?: string | null
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

export const PLATFORM_MAX_SCAN_BUDGET_USD = env.PLATFORM_MAX_SCAN_BUDGET_USD

/**
 * Every engine run must have a positive spend cap. A policy can reduce the
 * selected profile ceiling but can never silently upgrade a cheaper review.
 * An explicitly zero budget is a deliberate policy choice and must fail the
 * scan rather than silently falling back to the profile default.
 */
export function resolveScanBudgetUsd(mode: string, policyMaxBudgetUsd?: number | null): number {
  const profile = resolveScanProfile({ targetType: "REPO", mode })
  if (typeof policyMaxBudgetUsd === "number" && Number.isFinite(policyMaxBudgetUsd)) {
    if (policyMaxBudgetUsd === 0) return 0
    if (policyMaxBudgetUsd > 0) {
      return Math.min(profile.maxBudgetUsd, policyMaxBudgetUsd, PLATFORM_MAX_SCAN_BUDGET_USD)
    }
  }

  return Math.min(profile.maxBudgetUsd, PLATFORM_MAX_SCAN_BUDGET_USD)
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

function validateInstruction(instruction: string | undefined): string | undefined {
  if (!instruction) return undefined
  const safety = checkInstructionSafety(instruction)
  if (!safety.safe) {
    throw new Error(`Engine instruction rejected: ${safety.reason}`)
  }
  return instruction
}

export function buildEngineCommand(config: ScanConfig): EngineCommand {
  const executable = resolveExecutable()
  const targetArg = resolveTargetArg(config.target)
  // The external engine only has three native modes. Resolve through the
  // repository profile even for direct command-builder callers so legacy
  // aliases are normalized and invalid modes fail before a provider call.
  const scanMode = resolveScanProfile({ targetType: "REPO", mode: config.mode }).engineMode
  if (!scanMode) throw new Error("SCAN_MODE_UNSUPPORTED")

  const args: string[] = [
    "--non-interactive",
    "--run-name",
    config.scanId,
    "--target",
    targetArg,
    "--scan-mode",
    scanMode,
  ]

  const validatedInstruction = validateInstruction(config.instruction)
  if (validatedInstruction) {
    args.push("--instruction", validatedInstruction)
  }

  if (config.target.type === "REPO" && config.target.branch?.trim()) {
    args.push("--repository-branch", config.target.branch.trim())
  }

  if (config.maxBudgetUsd && config.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(config.maxBudgetUsd))
  }

  const workDir = engineWorkspacePath(config.scanId)

  return { executable, args, workDir }
}
