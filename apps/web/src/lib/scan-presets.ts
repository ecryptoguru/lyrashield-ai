import {
  getUrlModeAvailability,
  getUrlScanProfile,
  type UrlScanMode,
  type UrlTargetType,
} from "@lyrashield/types"
import { estimateRunMinutes } from "./estimator"

export const SCAN_PRESETS = {
  RELEASE_CHECK: {
    label: "Release check",
    description: "Fast, bounded scan before you ship.",
    hint: "Quick pass over the repository snapshot, its public surfaces and configs. Best for pre-release confidence.",
    goal: "LAUNCH_REVIEW",
    mode: "QUICK",
  },
  CODE_REVIEW: {
    label: "Code scan",
    description: "Broader repository and dependency analysis.",
    hint: "Dependency and risky-pattern checks across the repository.",
    goal: "TEST_APP",
    mode: "STANDARD",
  },
  DEEP_REVIEW: {
    label: "Deep security scan",
    description: "Deep cross-file scan for complex or high-risk releases.",
    hint: "Cross-file taint and reachability analysis for high-risk changes.",
    goal: "FULL_PENTEST",
    mode: "DEEP",
  },
  REVIEW_CHANGES: {
    label: "Scan changes",
    description: "Bounded scan of an exact code diff between two revisions.",
    hint: "Analyzes only the recorded change set between an immutable base and head. Requires a base ref; the head defaults to the target branch.",
    goal: "CHECK_PR",
    mode: "QUICK",
  },
  WEEKLY_MONITOR: {
    label: "Weekly monitor",
    description: "A bounded recurring check for new risk.",
    hint: "Light recurring sweep to catch new regressions between releases.",
    goal: "WEEKLY_MONITOR",
    mode: "QUICK",
  },
} as const

type ScanPresetId = keyof typeof SCAN_PRESETS

const SCAN_PRESET_ORDER: ScanPresetId[] = [
  "RELEASE_CHECK",
  "CODE_REVIEW",
  "REVIEW_CHANGES",
  "DEEP_REVIEW",
  "WEEKLY_MONITOR",
]

/** The default scan for a repository target is the Standard-depth code
 * scan — not the cheapest option — so a first scan has real coverage. */
const REPO_DEFAULT_PRESET: ScanPresetId = "CODE_REVIEW"

/** Deterministic scanner families applicable to a repository target. */
const REPO_APPLICABLE_CHECKS = [
  "Engine code scan",
  "Secrets",
  "Dependency advisories",
  "Risky patterns (SAST)",
  "IaC configs",
  "Agent config",
  "AI app security",
  "ML supply chain",
] as const

const REPO_LIMITS: Record<string, string> = {
  QUICK: "Up to 15 minutes of engine time",
  STANDARD: "Up to 20 minutes of engine time",
  DEEP: "Up to 45 minutes of engine time",
}

const URL_LIMITS: Record<string, string> = {
  SAFE: "Bounded deterministic checks only",
  STANDARD: "Up to 20 minutes of engine time",
  DEEP: "Up to 45 minutes of engine time",
}

export type ScanWorkflowId = "REVIEW_TARGET" | "REVIEW_CHANGES" | "AUTHENTICATED_ASSESSMENT"

export type ManualScanOption = {
  id: string
  label: string
  description: string
  hint: string
  goal: string
  mode: string
  estimate: { low: number; high: number }
  available: boolean
  disabledReason?: string
  /** Whether the engine runs for this option (deterministic tier = false). */
  usesAi?: boolean
  /** Workflow recorded on the immutable execution plan. */
  workflow: ScanWorkflowId
  /** Review Changes requires a base ref (and optionally a head ref) resolved
   * to immutable revisions server-side before the scan is admitted. */
  requiresRevisionInputs?: boolean
  /** The default pick for the target type. */
  isDefault?: boolean
  /** Truthful creation-time summary — what the scan will actually do. */
  scopeSummary: string
  limitsSummary: string
  applicableChecks: readonly string[]
  /** Authorization the scan needs beyond workspace membership. */
  authorizationHint?: string
}

function repoOptions(): ManualScanOption[] {
  return SCAN_PRESET_ORDER.filter((id) => id !== "WEEKLY_MONITOR").map((id) => {
    const preset = SCAN_PRESETS[id]
    const isReviewChanges = id === "REVIEW_CHANGES"
    return {
      id,
      label: preset.label,
      description: preset.description,
      hint: preset.hint,
      goal: preset.goal,
      mode: preset.mode,
      estimate: estimateRunMinutes(preset.mode),
      available: true,
      usesAi: true,
      workflow: isReviewChanges ? "REVIEW_CHANGES" : "REVIEW_TARGET",
      ...(isReviewChanges ? { requiresRevisionInputs: true } : {}),
      ...(id === REPO_DEFAULT_PRESET ? { isDefault: true } : {}),
      scopeSummary: isReviewChanges
        ? "Only the recorded diff between the resolved base and head revisions."
        : "The full repository snapshot at the pinned revision.",
      limitsSummary: REPO_LIMITS[preset.mode] ?? "Bounded scan",
      applicableChecks: REPO_APPLICABLE_CHECKS,
      ...(isReviewChanges
        ? {
            authorizationHint:
              "Refs are resolved through the connected GitHub App; both sides pin to immutable commits.",
          }
        : {}),
    }
  })
}

// Engine-backed URL modes consume agent-minutes at repo-mode rates — the
// deterministic tier stays cheap.
const URL_ESTIMATES: Record<string, { low: number; high: number }> = {
  WEB_APP_SAFE: { low: 1, high: 2 },
  WEB_APP_STANDARD: { low: 12, high: 23 },
  WEB_APP_DEEP: { low: 25, high: 40 },
  API_SAFE: { low: 1, high: 2 },
  API_STANDARD: { low: 12, high: 23 },
  API_DEEP: { low: 25, high: 40 },
}

function goalForUrlMode(mode: UrlScanMode): string {
  switch (mode) {
    case "SAFE":
      return "LAUNCH_REVIEW"
    case "STANDARD":
      return "TEST_APP"
    case "DEEP":
      return "FULL_PENTEST"
    default:
      return "LAUNCH_REVIEW"
  }
}

function urlOptions(targetType: UrlTargetType, hasApiSpec: boolean): ManualScanOption[] {
  const modes: UrlScanMode[] = ["SAFE", "STANDARD", "DEEP"]
  const options: ManualScanOption[] = []

  for (const mode of modes) {
    const availability = getUrlModeAvailability(targetType, mode, hasApiSpec)
    const profile = getUrlScanProfile(targetType, mode)
    const engineBacked = mode !== "SAFE"
    options.push({
      id: profile.id,
      label: profile.label,
      description: profile.description,
      hint: profile.description,
      goal: goalForUrlMode(mode),
      mode,
      estimate: URL_ESTIMATES[profile.id] ?? { low: 1, high: 2 },
      available: availability.available,
      disabledReason: availability.available ? undefined : availability.reason,
      usesAi: engineBacked,
      workflow: "REVIEW_TARGET",
      scopeSummary: engineBacked
        ? "The live target origin through the scan-scoped relay."
        : "The public surface of the target URL — no engine scan.",
      limitsSummary: URL_LIMITS[mode] ?? "Bounded scan",
      applicableChecks: engineBacked
        ? ["Engine scan", "Public surface checks"]
        : ["Public surface checks"],
      ...(engineBacked
        ? {
            authorizationHint:
              "Requires a verified domain on a paid plan before the engine sends its first request.",
          }
        : {}),
    })
  }

  return options
}

export function getManualScanOptions(target: {
  type: string
  hasApiSpec?: boolean | null
}): ManualScanOption[] {
  if (!target.type) {
    return []
  }

  if (target.type === "REPO") {
    return repoOptions()
  }

  if (target.type === "WEB_APP" || target.type === "API") {
    return urlOptions(target.type, Boolean(target.hasApiSpec))
  }

  return repoOptions()
}

/** The preset id to preselect for a target: its marked default, else the
 * first available option. */
export function getDefaultScanOptionId(options: ManualScanOption[]): string {
  return (
    options.find((option) => option.isDefault && option.available)?.id ??
    options.find((option) => option.available)?.id ??
    ""
  )
}

export function getScanPreset(id: string) {
  return SCAN_PRESETS[id as ScanPresetId] ?? SCAN_PRESETS.RELEASE_CHECK
}

export function getScanPresetEstimate(id: string) {
  return estimateRunMinutes(getScanPreset(id).mode)
}
