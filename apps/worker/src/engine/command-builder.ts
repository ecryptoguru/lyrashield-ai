import type { RepositoryAuth } from "./repository-auth"
import { env } from "@lyrashield/config"
import {
  buildEngineArguments,
  resolveScanBudgetUsd as resolveSharedScanBudgetUsd,
  type EngineCommandConfig,
} from "@lyrashield/security"
import { engineWorkspacePath } from "./workspace-path"

export type {
  EngineTargetType as TargetType,
  EngineTargetInfo as TargetInfo,
} from "@lyrashield/security"
export interface ScanConfig extends EngineCommandConfig {
  /** Scan-scoped relay grant for engine-backed URL/API targets. */
  relay?: { url: string; grant: string }
  /** Engine-host Git authentication; never serialized into arguments or sandbox inputs. */
  repositoryAuth?: RepositoryAuth
}

export interface EngineCommand {
  executable: string
  args: string[]
  workDir: string
}

const PLATFORM_MAX_SCAN_BUDGET_USD = env.PLATFORM_MAX_SCAN_BUDGET_USD

/**
 * Every engine run must have a positive spend cap. A policy can reduce the
 * selected profile ceiling but can never silently upgrade a cheaper review.
 * An explicitly zero budget is a deliberate policy choice and must fail the
 * scan rather than silently falling back to the profile default.
 */
export function resolveScanBudgetUsd(
  mode: string,
  policyMaxBudgetUsd?: number | null,
  targetType: string = "REPO"
): number {
  return resolveSharedScanBudgetUsd(
    mode,
    policyMaxBudgetUsd,
    targetType,
    PLATFORM_MAX_SCAN_BUDGET_USD
  )
}

function resolveExecutable(): string {
  const enginePath = env.LYRASHIELD_ENGINE_PATH
  if (enginePath) return enginePath
  return "lyrashield"
}

export function buildEngineCommand(
  config: ScanConfig,
  timeoutMs: number | null = null
): EngineCommand {
  return {
    executable: resolveExecutable(),
    args: buildEngineArguments(config, timeoutMs),
    workDir: engineWorkspacePath(config.scanId),
  }
}
