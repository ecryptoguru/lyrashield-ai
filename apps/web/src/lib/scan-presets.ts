import {
  getUrlModeAvailability,
  getUrlScanProfile,
  type UrlScanMode,
  type UrlScanProfile,
  type UrlTargetType,
} from "@lyrashield/types"
import { estimateRunMinutes } from "./estimator"

export const SCAN_PRESETS = {
  RELEASE_CHECK: {
    label: "Release check",
    description: "Fast, bounded review before you ship.",
    hint: "Quick pass over changed files, public surfaces, and configs. Best for pre-release confidence.",
    goal: "LAUNCH_REVIEW",
    mode: "SAFE",
  },
  CODE_REVIEW: {
    label: "Code review",
    description: "Broader repository and dependency analysis.",
    hint: "Full repo scan with dependency and risky-pattern checks.",
    goal: "TEST_APP",
    mode: "STANDARD",
  },
  DEEP_REVIEW: {
    label: "Deep security review",
    description: "Deep cross-file review for complex or high-risk releases.",
    hint: "Cross-file taint and reachability analysis for high-risk changes.",
    goal: "FULL_PENTEST",
    mode: "DEEP",
  },
  WEEKLY_MONITOR: {
    label: "Weekly monitor",
    description: "A bounded recurring check for new risk.",
    hint: "Light recurring sweep to catch new regressions between releases.",
    goal: "WEEKLY_MONITOR",
    mode: "SAFE",
  },
} as const

export type ScanPresetId = keyof typeof SCAN_PRESETS

export const SCAN_PRESET_ORDER: ScanPresetId[] = [
  "RELEASE_CHECK",
  "CODE_REVIEW",
  "DEEP_REVIEW",
  "WEEKLY_MONITOR",
]

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
}

function repoOptions(): ManualScanOption[] {
  return SCAN_PRESET_ORDER.filter((id) => id !== "WEEKLY_MONITOR").map((id) => {
    const preset = SCAN_PRESETS[id]
    return {
      id,
      label: preset.label,
      description: preset.description,
      hint: preset.hint,
      goal: preset.goal,
      mode: preset.mode,
      estimate: estimateRunMinutes(preset.mode),
      available: true,
    }
  })
}

const URL_ESTIMATES: Record<string, { low: number; high: number }> = {
  WEB_APP_SAFE: { low: 1, high: 2 },
  WEB_APP_STANDARD: { low: 4, high: 6 },
  WEB_APP_DEEP: { low: 8, high: 15 },
  API_SAFE: { low: 1, high: 2 },
  API_STANDARD: { low: 2, high: 4 },
  API_DEEP: { low: 4, high: 8 },
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

function urlOptions(
  targetType: UrlTargetType,
  hasApiSpec: boolean
): ManualScanOption[] {
  const modes: UrlScanMode[] = ["SAFE", "STANDARD", "DEEP"]
  const options: ManualScanOption[] = []

  for (const mode of modes) {
    const availability = getUrlModeAvailability(targetType, mode, hasApiSpec)
    const profile = getUrlScanProfile(targetType, mode)
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

export function getScanPreset(id: string) {
  return SCAN_PRESETS[id as ScanPresetId] ?? SCAN_PRESETS.RELEASE_CHECK
}

export function getScanPresetEstimate(id: string) {
  return estimateRunMinutes(getScanPreset(id).mode)
}

export function isScanPresetId(id: string): id is ScanPresetId {
  return (Object.keys(SCAN_PRESETS) as ScanPresetId[]).includes(id as ScanPresetId)
}

export function getUrlProfileFromOption(
  option: ManualScanOption
): UrlScanProfile | null {
  try {
    return getUrlScanProfile(
      option.id.startsWith("API") ? "API" : "WEB_APP",
      option.mode as UrlScanMode
    )
  } catch {
    return null
  }
}
