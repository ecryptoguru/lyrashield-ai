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

export function getScanPreset(id: string) {
  return SCAN_PRESETS[id as ScanPresetId] ?? SCAN_PRESETS.RELEASE_CHECK
}

export function isScanPresetId(id: string): id is ScanPresetId {
  return (Object.keys(SCAN_PRESETS) as ScanPresetId[]).includes(id as ScanPresetId)
}
