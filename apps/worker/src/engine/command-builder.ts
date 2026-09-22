import { env } from "@lyrashield/config"
import { checkInstructionSafety } from "@lyrashield/security"
import { resolveScanProfile, type ScanExecutionPlan } from "@lyrashield/types"
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
  /** OpenAPI document URL — passed as a second --target for API targets so the engine authorizes its declared base URLs as in-scope. */
  apiSpecUrl?: string | null
  instruction?: string
  maxBudgetUsd?: number
  /** Scan-scoped relay grant for engine-backed URL/API targets. */
  relay?: { url: string; grant: string }
  /**
   * Validated stored execution plan (hash-verified upstream in run-scan
   * authority). Its scope drives --scope-mode: a DIFF plan (Review Changes)
   * pins the immutable recorded revisions via --diff-base/--diff-head and,
   * for remote repository targets, --repository-revision. Every other engine
   * run is an explicit full snapshot. Legacy pre-plan rows pass null.
   */
  executionPlan?: ScanExecutionPlan | null
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
export function resolveScanBudgetUsd(
  mode: string,
  policyMaxBudgetUsd?: number | null,
  targetType: string = "REPO"
): number {
  const profile = resolveScanProfile({ targetType, mode })
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

function isRemoteRepoRef(arg: string): boolean {
  const value = arg.trim()
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("git@") ||
    value.startsWith("git://") ||
    value.endsWith(".git")
  )
}

/**
 * Map a worker-known target shape onto the engine's `--target-type` kind.
 * Engine target inference is offline-only, so a non-suffixed HTTP(S) Git
 * remote would otherwise classify as a web target. Returns null when no
 * confident mapping exists — omission retains the engine's offline inference.
 * The flag only classifies input; it never authorizes fetching the target.
 */
function resolveEngineTargetKind(target: TargetInfo, targetArg: string): string | null {
  switch (target.type) {
    case "REPO":
      // A checked-out source tree is already local; remote refs clone via the
      // engine's guarded repository path.
      return isRemoteRepoRef(targetArg) ? "repository" : "local_code"
    case "WEB_APP":
    case "API":
      return "web_application"
    default:
      return null
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
  // Resolve through the target's own profile so URL/API modes normalize the
  // same way as repository aliases and invalid modes fail before a provider call.
  const scanMode = resolveScanProfile({
    targetType: config.target.type,
    mode: config.mode,
  }).engineMode
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

  // Pin the declared kind so offline inference cannot misclassify a
  // non-suffixed Git remote as a web target (and vice versa). The flag applies
  // to every --target entry, including an API target's spec URL.
  const engineTargetKind = resolveEngineTargetKind(config.target, targetArg)
  if (engineTargetKind) {
    args.push("--target-type", engineTargetKind)
  }

  // Scope pinning comes straight from the stored, hash-verified plan — never
  // from the queue payload. Review Changes (scope DIFF) asserts the recorded
  // immutable comparison; every other engine run is an explicit full snapshot
  // rather than the engine's ambient `auto` diff heuristic in a headless
  // worker.
  //
  // MERGE-BLOCKER (deployment order handled at release, Task 13 bridge):
  // --diff-head/--repository-revision exist only on the post-8fe5736c engine;
  // the pinned engine predates them. Plan ordering covers this — no runtime
  // flag detection here.
  const executionPlan = config.executionPlan ?? null
  const isDiffScope = executionPlan?.scope === "DIFF"
  if (isDiffScope) {
    const source = executionPlan.source
    if (
      config.target.type !== "REPO" ||
      !source?.revision ||
      !source.baseRevision ||
      !source.mergeBaseRevision
    ) {
      // A schema-valid DIFF plan always carries all three resolved revisions
      // on a REPO target; reaching this is contract tampering, not input.
      throw new Error("SCAN_PLAN_INVALID")
    }
    // --diff-base carries the recorded effective merge base, not the requested
    // base tip: merge-base(mb, head) === mb because the merge base is an
    // ancestor of head, so the engine's derived <base>...<head> range is
    // exactly the admission-authorized comparison — immune to merge-base
    // recomputation drift (e.g. criss-cross histories). --diff-head asserts
    // the checkout's HEAD equals the recorded head revision, and
    // --repository-revision pins a remote clone to that same commit.
    args.push(
      "--scope-mode",
      "diff",
      "--diff-base",
      source.mergeBaseRevision,
      "--diff-head",
      source.revision
    )
  } else {
    args.push("--scope-mode", "full")
  }
  // A snapshot is just as immutable as a diff. The branch below is only a
  // fetch hint; the recorded revision owns the checkout for every repo plan.
  if (
    executionPlan?.source?.revision &&
    config.target.type === "REPO" &&
    isRemoteRepoRef(targetArg)
  ) {
    args.push("--repository-revision", executionPlan.source.revision)
  }

  // API targets: the OpenAPI document is a second engine target — the engine
  // authorizes the spec's declared base URLs as in-scope on its own side.
  if (config.target.type === "API" && config.apiSpecUrl?.trim()) {
    args.push("--target", config.apiSpecUrl.trim())
  }

  const validatedInstruction = validateInstruction(config.instruction)
  if (validatedInstruction) {
    args.push("--instruction", validatedInstruction)
  }

  // A configured branch is only a fetch hint; for a Review Changes run the
  // recorded immutable revisions own the checkout, and a stale or full-SHA
  // branch could only conflict with them.
  if (config.target.type === "REPO" && config.target.branch?.trim() && !isDiffScope) {
    args.push("--repository-branch", config.target.branch.trim())
  }

  if (config.maxBudgetUsd && config.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(config.maxBudgetUsd))
  }

  const workDir = engineWorkspacePath(config.scanId)

  return { executable, args, workDir }
}
